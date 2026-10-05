import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

// Pass-through fs whose fsync can be made to fail, to check that no temp file is left behind.
const fsState = vi.hoisted(() => ({ failFsync: false }));
vi.mock("node:fs", async (orig) => {
  const fs = await orig<typeof import("node:fs")>();
  return {
    ...fs,
    fsyncSync: (fd: number) => {
      if (fsState.failFsync) throw Object.assign(new Error("EIO: i/o error, fsync"), { code: "EIO" });
      return fs.fsyncSync(fd);
    },
  };
});

import {
  addWorkspace,
  chooseWorkspace,
  DEFAULT_CONFIG_FILE,
  findDuplicateTeams,
  findProjectSettings,
  foreignReason,
  inspectOwnedFile,
  loadConfig,
  projectReadWarnings,
  projectWriteWarnings,
  recheckWriteBlock,
  trustKey,
  loadTrust,
  projectWriteBlock,
  recordTrust,
  removeTrust,
  trustFilePath,
  trustedWorkspace,
  parseBoolEnv,
  removeStaleLock,
  resolveWorkspace,
  saveConfig,
  teamAliases,
  updateConfig,
  writeFileAtomic,
} from "../src/config.js";
import { setActiveConfig, slackerCommand } from "../src/command.js";

const root = mkdtempSync(join(tmpdir(), "slacker-config-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => {
  fsState.failFsync = false;
  setActiveConfig(undefined);
});

let n = 0;
function tempConfig(content: unknown): string {
  const dir = join(root, `c${++n}`);
  mkdirSync(dir);
  const file = join(dir, "config.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

const ws = (teamId: string, extra: Record<string, unknown> = {}) => ({
  token: `xoxc-${teamId}`,
  cookie: "xoxd-c",
  url: `https://${teamId.toLowerCase()}.slack.com/`,
  userId: "U1",
  teamId,
  ...extra,
});
const mode = (p: string) => statSync(p).mode & 0o777;

describe("saveConfig", () => {
  it("preserves unknown keys, tightens perms and leaves no temp file", () => {
    const file = tempConfig({ workspaces: { work: ws("T1", { lastUsed: 123 }) }, defaultWorkspace: "work", version: 2, theme: { a: 1 } });
    chmodSync(file, 0o644);
    const config = loadConfig(file);
    config.workspaces.work.cookie = "xoxd-new";
    saveConfig(config, file);

    const saved = JSON.parse(readFileSync(file, "utf-8"));
    expect(saved).toMatchObject({ version: 2, theme: { a: 1 }, defaultWorkspace: "work" });
    expect(saved.workspaces.work).toMatchObject({ lastUsed: 123, cookie: "xoxd-new" });
    expect(mode(file)).toBe(0o600);
    expect(readdirSync(join(file, ".."))).toEqual(["config.json"]);
  });

  it("addWorkspace keeps extra keys when updating the same team", () => {
    const file = tempConfig({ workspaces: { work: ws("T1", { note: "keep" }) }, defaultWorkspace: "work" });
    addWorkspace("work", ws("T1", { token: "xoxc-new" }), file);
    expect(loadConfig(file).workspaces.work).toMatchObject({ note: "keep", token: "xoxc-new" });
  });

  it("creates missing dirs as 0700 but leaves an existing user dir alone", () => {
    const fresh = join(root, "fresh", "nested", "config.json");
    saveConfig({ workspaces: {}, defaultWorkspace: null }, fresh);
    expect(mode(join(root, "fresh", "nested"))).toBe(0o700);
    expect(mode(fresh)).toBe(0o600);

    const shared = join(root, "shared");
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    saveConfig({ workspaces: {}, defaultWorkspace: null }, join(shared, "config.json"));
    expect(mode(shared)).toBe(0o755);
  });

  it("writes through a symlinked config file", () => {
    const real = tempConfig({ workspaces: {}, defaultWorkspace: null });
    const link = join(root, "link-config.json");
    symlinkSync(real, link);
    addWorkspace("work", ws("T1"), link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(loadConfig(real).workspaces.work).toBeDefined();
  });

  it("rejects names that could clobber object prototypes", () => {
    const file = tempConfig({ workspaces: {}, defaultWorkspace: null });
    expect(() => addWorkspace("__proto__", ws("T1"), file)).toThrow(/Invalid workspace name/);
    expect(() => addWorkspace("", ws("T1"), file)).toThrow(/Invalid workspace name/);
  });
});

describe("loadConfig validation", () => {
  it("returns an empty config when the file is missing", () => {
    expect(loadConfig(join(root, "nope.json"))).toEqual({ workspaces: {}, defaultWorkspace: null });
  });

  it.each([
    ["corrupt JSON", "{not json", /Could not parse Slack config/],
    ["null", "null", /top level/],
    ["array", "[]", /top level/],
    ["workspaces array", { workspaces: [] }, /"workspaces" must be an object/],
    ["workspace string", { workspaces: { work: "xoxc" } }, /workspace "work" must be an object/],
    ["missing token", { workspaces: { work: { cookie: "xoxd" } } }, /missing a string "token"/],
    ["numeric cookie", { workspaces: { work: { token: "xoxc", cookie: 5 } } }, /missing a string "cookie"/],
    ["numeric teamId", { workspaces: { work: { token: "xoxc", cookie: "xoxd", teamId: 5 } } }, /non-string "teamId"/],
    ["bad default", { workspaces: {}, defaultWorkspace: 3 }, /defaultWorkspace/],
  ])("rejects %s with a clear error naming the file", (_label, content, pattern) => {
    const file = tempConfig(content);
    expect(() => loadConfig(file)).toThrow(pattern);
    expect(() => loadConfig(file)).toThrow(file);
  });

  it("fills missing optional fields", () => {
    const file = tempConfig({ workspaces: { work: { token: "xoxc", cookie: "xoxd" } } });
    expect(loadConfig(file)).toMatchObject({ defaultWorkspace: null, workspaces: { work: { url: "", userId: "", teamId: "" } } });
  });
});

describe("resolveWorkspace", () => {
  const file = tempConfig({ workspaces: { work: ws("T1"), side: ws("T2") }, defaultWorkspace: "work" });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("does not resolve prototype key %s", (name) => {
    expect(() => resolveWorkspace(name, file)).toThrow(/not found.*Available: work, side/);
  });

  it("resolves a real entry", () => {
    expect(resolveWorkspace("side", file)).toMatchObject({ name: "side", teamId: "T2" });
  });
});

describe("teamAliases / findDuplicateTeams", () => {
  const file = tempConfig({
    workspaces: { "curly-braces": ws("T1"), uipath: ws("T1"), side: ws("T2"), blank: ws("") },
    defaultWorkspace: "uipath",
  });

  it("lists other names for the same team", () => {
    expect(teamAliases("uipath", file)).toEqual(["curly-braces"]);
    expect(teamAliases("curly-braces", file)).toEqual(["uipath"]);
    expect(teamAliases("side", file)).toEqual([]);
    expect(teamAliases("blank", file)).toEqual([]);
    expect(teamAliases("missing", file)).toEqual([]);
    expect(teamAliases("constructor", file)).toEqual([]);
  });

  it("groups duplicate teams", () => {
    expect(findDuplicateTeams(loadConfig(file))).toEqual([["curly-braces", "uipath"]]);
  });
});

describe("parseBoolEnv", () => {
  it.each([undefined, "", "0", "false", "FALSE", "no", "No", "off", " off "])("%s → false", (v) => {
    expect(parseBoolEnv(v)).toBe(false);
  });
  it.each(["1", "true", "TRUE", "yes", "YES", "on", "On", "y", "enabled", "garbage"])("%s → true (fails closed)", (v) => {
    expect(parseBoolEnv(v)).toBe(true);
  });
});

describe("atomic writes", () => {
  const dirOf = (file: string) => readdirSync(join(file, ".."));

  it("saveConfig removes its temp file when fsync fails", () => {
    const file = tempConfig({ workspaces: {}, defaultWorkspace: null });
    const before = readFileSync(file, "utf-8");
    fsState.failFsync = true;
    expect(() => saveConfig({ workspaces: { w: ws("T1") }, defaultWorkspace: "w" }, file)).toThrow(/EIO/);
    expect(dirOf(file)).toEqual(["config.json"]);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("saveConfig removes its temp file when the rename fails", () => {
    const dir = join(root, `rename${++n}`);
    const target = join(dir, "config.json");
    mkdirSync(join(target, "occupied"), { recursive: true }); // a directory where the file should go
    expect(() => saveConfig({ workspaces: {}, defaultWorkspace: null }, target)).toThrow();
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("writeFileAtomic creates new files with the given mode and keeps an existing file's mode", () => {
    const dir = join(root, `atomic${++n}`);
    mkdirSync(dir);
    const fresh = join(dir, ".mcp.json");
    writeFileAtomic(fresh, '{"a":1}\n');
    expect(readFileSync(fresh, "utf-8")).toBe('{"a":1}\n');
    expect(mode(fresh)).toBe(0o644);

    const priv = join(dir, ".slacker.json");
    writeFileSync(priv, "{}");
    chmodSync(priv, 0o600);
    writeFileAtomic(priv, '{"workspace":"w"}');
    expect(mode(priv)).toBe(0o600);
    expect(readFileSync(priv, "utf-8")).toBe('{"workspace":"w"}');
    expect(readdirSync(dir).sort()).toEqual([".mcp.json", ".slacker.json"]);
  });

  it("writeFileAtomic writes through a symlink and cleans up on failure", () => {
    const dir = join(root, `atomic${++n}`);
    mkdirSync(dir);
    const real = join(dir, "real.json");
    writeFileSync(real, "old");
    const link = join(dir, "link.json");
    symlinkSync(real, link);
    writeFileAtomic(link, "new");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, "utf-8")).toBe("new");

    fsState.failFsync = true;
    expect(() => writeFileAtomic(real, "newer")).toThrow(/EIO/);
    expect(readFileSync(real, "utf-8")).toBe("new");
    expect(readdirSync(dir).sort()).toEqual(["link.json", "real.json"]);
  });
});

describe("updateConfig", () => {
  const lockOf = (file: string) => `${file}.lock`;

  it("loads fresh, saves changes and releases the lock", () => {
    const file = tempConfig({ workspaces: { work: ws("T1") }, defaultWorkspace: "work" });
    const r = updateConfig(file, (c) => {
      c.defaultWorkspace = null;
      return "done";
    });
    expect(r).toBe("done");
    expect(loadConfig(file).defaultWorkspace).toBeNull();
    expect(existsSync(lockOf(file))).toBe(false);
  });

  it("does not rewrite an unchanged config", () => {
    const file = tempConfig({ workspaces: { work: ws("T1") }, defaultWorkspace: "work" });
    const before = readFileSync(file, "utf-8");
    updateConfig(file, () => undefined);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });

  it("writes nothing and releases the lock when mutate throws", () => {
    const file = tempConfig({ workspaces: { work: ws("T1") }, defaultWorkspace: "work" });
    const before = readFileSync(file, "utf-8");
    expect(() =>
      updateConfig(file, (c) => {
        c.defaultWorkspace = null;
        throw new Error("nope");
      })
    ).toThrow("nope");
    expect(readFileSync(file, "utf-8")).toBe(before);
    expect(existsSync(lockOf(file))).toBe(false);
  });

  it("waits for a live lock, then fails with a clear message", () => {
    const file = tempConfig({ workspaces: {}, defaultWorkspace: null });
    writeFileSync(lockOf(file), "other");
    const started = Date.now();
    expect(() => updateConfig(file, () => undefined, { waitMs: 100 })).toThrow(/Another slacker process is updating .*lock file/);
    expect(() => updateConfig(file, () => undefined, { waitMs: 0 })).toThrow(expect.objectContaining({ code: "config_locked" })); // F7
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(readFileSync(lockOf(file), "utf-8")).toBe("other"); // not ours to remove
  });

  it("takes over a stale lock left by a crashed process", () => {
    const file = tempConfig({ workspaces: {}, defaultWorkspace: null });
    writeFileSync(lockOf(file), "crashed");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lockOf(file), old, old);
    updateConfig(file, (c) => putDefault(c, "x"));
    expect(loadConfig(file).defaultWorkspace).toBe("x");
    expect(existsSync(lockOf(file))).toBe(false);
  });

  it("locks the real file behind a symlink", () => {
    const real = tempConfig({ workspaces: {}, defaultWorkspace: null });
    const link = join(root, `lock-link${++n}.json`);
    symlinkSync(real, link);
    writeFileSync(lockOf(real), "other");
    expect(() => updateConfig(link, () => undefined, { waitMs: 0 })).toThrow(/Another slacker process/);
  });

  it("addWorkspace uses the lock and only makes the first workspace the default", () => {
    const file = tempConfig({ workspaces: { side: ws("T2") }, defaultWorkspace: null });
    addWorkspace("work", ws("T1"), file);
    expect(loadConfig(file).defaultWorkspace).toBeNull();
    const empty = tempConfig({ workspaces: {}, defaultWorkspace: null });
    addWorkspace("work", ws("T1"), empty);
    expect(loadConfig(empty).defaultWorkspace).toBe("work");

    // A stale lock is only cleaned up by code that takes the lock.
    writeFileSync(lockOf(file), "crashed");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lockOf(file), old, old);
    addWorkspace("third", ws("T3"), file);
    expect(existsSync(lockOf(file))).toBe(false);
  });
});

function putDefault(c: { defaultWorkspace: string | null }, name: string) {
  c.defaultWorkspace = name;
}

describe("resolveWorkspace trims names", () => {
  const file = tempConfig({ workspaces: { work: ws("T1") }, defaultWorkspace: "work" });
  it.each([" work", "work ", "\twork\n"])("%j → work", (name) => {
    expect(resolveWorkspace(name, file).name).toBe("work");
  });
  it("blank falls back to the default", () => {
    expect(resolveWorkspace("  ", file).name).toBe("work");
  });
});

describe("slackerCommand / setActiveConfig", () => {
  const argv1 = process.argv[1];
  afterEach(() => {
    process.argv[1] = argv1;
  });

  it("has no -c for the default config", () => {
    process.argv[1] = "/usr/local/bin/slacker";
    expect(slackerCommand()).toBe("slacker");
    setActiveConfig(DEFAULT_CONFIG_FILE);
    expect(slackerCommand()).toBe("slacker");
    setActiveConfig(join(DEFAULT_CONFIG_FILE, "..", ".", "config.json")); // same file, different spelling
    expect(slackerCommand()).toBe("slacker");
  });

  it("adds a quoted -c for another config (bin form)", () => {
    process.argv[1] = "/usr/local/bin/slacker";
    setActiveConfig("/tmp/my configs/work.json");
    expect(slackerCommand()).toBe(`slacker -c "/tmp/my configs/work.json"`);
    setActiveConfig('/tmp/we"ird$x/c.json');
    expect(slackerCommand()).toBe(`slacker -c "/tmp/we\\"ird\\$x/c.json"`);
  });

  it("adds an absolute -c for a relative path (node + entry form)", () => {
    process.argv[1] = "/somewhere/dist/index.js";
    setActiveConfig("rel/config.json");
    const cmd = slackerCommand();
    expect(cmd).toMatch(/^".+" ".+index\.js" -c ".+"$/);
    expect(cmd.endsWith(` -c "${resolve("rel/config.json")}"`)).toBe(true);
  });

  it("is used by the config error messages", () => {
    process.argv[1] = "/usr/local/bin/slacker";
    const file = join(root, `missing${++n}`, "config.json");
    setActiveConfig(file);
    expect(() => resolveWorkspace(undefined, file)).toThrow(`Run 'slacker auth setup'`);
    expect(() => resolveWorkspace(undefined, file)).toThrow(`\n(run slacker as: slacker -c "${file}")`);
    const noDefault = tempConfig({ workspaces: { a: ws("T1") }, defaultWorkspace: null });
    setActiveConfig(noDefault);
    expect(() => resolveWorkspace(undefined, noDefault)).toThrow(`set a default with: slacker auth default <name>\n(run slacker as: slacker -c "${noDefault}")`);
  });
});

describe("stale lock takeover (F6)", () => {
  it("removes the lock it judged stale", () => {
    const lock = join(root, `stale${++n}.lock`);
    writeFileSync(lock, "crashed");
    const seen = statSync(lock);
    expect(removeStaleLock(lock, seen)).toBe(true);
    expect(existsSync(lock)).toBe(false);
  });

  it("leaves a fresh lock another process created after the stale check", () => {
    const lock = join(root, `stale${++n}.lock`);
    writeFileSync(lock, "crashed");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    const seen = statSync(lock); // judged stale…
    writeFileSync(`${lock}.new`, "fresh owner"); // …then another process took it over and locked again
    renameSync(`${lock}.new`, lock);
    expect(removeStaleLock(lock, seen)).toBe(false);
    expect(readFileSync(lock, "utf-8")).toBe("fresh owner");
    expect(readdirSync(root).filter((f) => f.includes(".stale"))).toEqual([]); // nothing left aside
  });

  it("is a no-op when the lock is already gone", () => {
    const lock = join(root, `stale${++n}.lock`);
    writeFileSync(lock, "x");
    const seen = statSync(lock);
    rmSync(lock);
    expect(removeStaleLock(lock, seen)).toBe(false);
  });
});

describe("workspace source in errors (F4, F7)", () => {
  const file = () => tempConfig({ workspaces: { work: ws("T1") }, defaultWorkspace: "gone" });

  it("names where the name came from, with a code", () => {
    const f = file();
    const err = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return e as { message: string; code: string };
      }
      throw new Error("expected a throw");
    };
    expect(err(() => resolveWorkspace("x", f, { source: "flag" })).message).toContain('Workspace "x" (from --workspace) not found');
    expect(err(() => resolveWorkspace("x", f, { source: "env" })).message).toContain("(from SLACKER_WORKSPACE)");
    expect(err(() => resolveWorkspace("x", f, { source: "project", projectFile: "/p/.slacker.json" })).message).toContain(
      "(from .slacker.json at /p/.slacker.json)"
    );
    const dflt = err(() => resolveWorkspace(undefined, f));
    expect(dflt.message).toContain('Workspace "gone" (defaultWorkspace in config.json) not found');
    expect(dflt.code).toBe("workspace_not_found");
    expect(err(() => resolveWorkspace("x", f)).message).toContain('Workspace "x" not found'); // source unknown: not guessed
  });
});

describe("chooseWorkspace with an invalid .slacker.json (F5)", () => {
  it("throws invalid_project_file, or skips it when asked", () => {
    const dir = mkdtempSync(join(root, "proj-"));
    writeFileSync(join(dir, ".slacker.json"), '{"readOnly": "yes"}');
    expect(() => chooseWorkspace(undefined, dir)).toThrow(expect.objectContaining({ code: "invalid_project_file" }));
    const c = chooseWorkspace("work", dir, { ignoreInvalidProject: true });
    expect(c).toMatchObject({ name: "work", source: "flag", readOnly: false });
    expect(c.ignoredProjectError).toMatch(/Invalid .*\.slacker\.json: "readOnly" must be true or false/);
  });
});

describe("project trust store", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it("defaults to ~/.config/slacker/trusted-projects.json via os.homedir() (HOME), overridable with SLACKER_TRUST_FILE", () => {
    const home = join(root, `home${++n}`);
    process.env.HOME = home;
    delete process.env.SLACKER_TRUST_FILE;
    expect(trustFilePath()).toBe(join(home, ".config", "slacker", "trusted-projects.json"));
    process.env.SLACKER_TRUST_FILE = "/elsewhere/t.json";
    expect(trustFilePath()).toBe("/elsewhere/t.json");
  });

  it("records, replaces and removes trust; dir 0700, file 0600, no temp or lock files left", () => {
    const dir = join(root, `trust${++n}`, "slacker");
    const file = join(dir, "trusted-projects.json");
    expect(recordTrust("/p/.slacker.json", "acme", file)).toBeUndefined();
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(trustedWorkspace("/p/.slacker.json", file)).toBe("acme");
    expect(recordTrust("/p/.slacker.json", "side", file)).toBe("acme");
    expect(loadTrust(file).projects["/p/.slacker.json"]).toMatchObject({ workspace: "side", trustedAt: expect.stringMatching(/^\d{4}-/) });
    expect(removeTrust("/p/.slacker.json", file)).toBe("side");
    expect(removeTrust("/p/.slacker.json", file)).toBeUndefined();
    expect(trustedWorkspace("/p/.slacker.json", file)).toBeUndefined();
    expect(readdirSync(dir)).toEqual(["trusted-projects.json"]);
  });

  it("a corrupt trust file is an error (invalid_trust_file), never silently replaced", () => {
    const file = join(root, `trust${++n}.json`);
    writeFileSync(file, "{oops");
    expect(() => trustedWorkspace("/p", file)).toThrow(expect.objectContaining({ code: "invalid_trust_file" }));
    expect(() => recordTrust("/p", "w", file)).toThrow(expect.objectContaining({ code: "invalid_trust_file" }));
    expect(readFileSync(file, "utf-8")).toBe("{oops");
  });
});

describe("chooseWorkspace and project trust", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function project(settings: unknown, fileMode = 0o644) {
    const dir = mkdtempSync(join(root, "trust-proj-"));
    const file = join(dir, ".slacker.json");
    writeFileSync(file, JSON.stringify(settings));
    chmodSync(file, fileMode);
    process.env.SLACKER_TRUST_FILE = join(dir, "trust.json");
    return { dir, file, real: realpathSync(file) };
  }

  it("an untrusted file chooses the workspace for reads but writes are blocked; trusting it lifts the block", () => {
    const p = project({ workspace: "acme" });
    let c = chooseWorkspace(undefined, p.dir);
    expect(c).toMatchObject({ name: "acme", source: "project", projectTrusted: false });
    expect(projectWriteBlock(c)).toMatchObject({ code: "untrusted_project" });
    recordTrust(p.real, "acme");
    c = chooseWorkspace(undefined, p.dir);
    expect(c.projectTrusted).toBe(true);
    expect(projectWriteBlock(c)).toBeUndefined();
  });

  it("trust is for one workspace: a changed file is untrusted again, naming both", () => {
    const p = project({ workspace: "acme" });
    recordTrust(p.real, "other");
    const c = chooseWorkspace(undefined, p.dir);
    expect(c).toMatchObject({ projectTrusted: false, trustedFor: "other" });
    expect(projectWriteBlock(c)?.message).toContain('(you trusted it for workspace "other", but it now says "acme")');
  });

  it("-w / SLACKER_WORKSPACE bypass the file's choice (no block), but readOnly still applies", () => {
    const p = project({ workspace: "acme", readOnly: true });
    expect(projectWriteBlock(chooseWorkspace("side", p.dir))).toBeUndefined();
    expect(chooseWorkspace("side", p.dir)).toMatchObject({ source: "flag", readOnly: true, projectTrusted: false });
    process.env.SLACKER_WORKSPACE = "side";
    expect(projectWriteBlock(chooseWorkspace(undefined, p.dir))).toBeUndefined();
  });

  it("a file without a workspace needs no trust", () => {
    const p = project({ readOnly: true });
    const c = chooseWorkspace(undefined, p.dir);
    expect(c).toMatchObject({ source: "default", readOnly: true });
    expect(c.projectTrusted).toBeUndefined();
    expect(projectWriteBlock(c)).toBeUndefined();
  });

  it.each([0o646, 0o662, 0o666])("mode %s (writable by others): ignored, unparsed, writes blocked even with -w", (fileMode) => {
    const p = project({ workspace: "acme", readOnly: true }, fileMode);
    expect(foreignReason(p.file)).toMatch(/^is writable by/);
    expect(findProjectSettings(p.dir)).toMatchObject({ file: p.file, settings: {}, foreign: expect.stringMatching(/writable/) });
    recordTrust(p.real, "acme"); // trust doesn't help while others can change it
    const c = chooseWorkspace("side", p.dir);
    expect(c).toMatchObject({ source: "flag", readOnly: false, foreignProject: { file: p.file } });
    expect(c.projectFile).toBeUndefined();
    expect(projectWriteBlock(c)).toMatchObject({ code: "untrusted_project", message: expect.stringContaining("might say \"readOnly\": true") });
    expect(chooseWorkspace(undefined, p.dir).source).toBe("default");
  });

  it("D6: your own file that only its group can write: ignored without -w; with -w/env it only adds readOnly, with a warning", () => {
    const p = project({ workspace: "acme", readOnly: true }, 0o664);
    const without = chooseWorkspace(undefined, p.dir);
    expect(without).toMatchObject({ source: "default", readOnly: false, foreignProject: { file: p.file, reason: "is writable by its group (mode 664)", fix: `chmod go-w ${p.file}` } });
    expect(projectWriteBlock(without)).toMatchObject({ code: "untrusted_project" });
    const named = chooseWorkspace("side", p.dir);
    expect(named).toMatchObject({ source: "flag", name: "side", readOnly: true, projectFile: p.file, groupWritableProject: { file: p.file } });
    expect(named.foreignProject).toBeUndefined();
    expect(named.projectTrusted).toBeUndefined();
    expect(projectWriteBlock(named)).toBeUndefined();
    expect(projectWriteWarnings(named)).toEqual([
      `${p.file} is writable by its group (mode 664), so only its "readOnly" is used (-w picks the workspace); without -w it's ignored and writes are refused. Fix: chmod g-w ${p.file}`,
    ]);
    expect(projectReadWarnings(named)).toEqual(projectWriteWarnings(named));
    process.env.SLACKER_WORKSPACE = "side";
    expect(projectWriteWarnings(chooseWorkspace(undefined, p.dir))[0]).toContain("(SLACKER_WORKSPACE picks the workspace)");
    // An invalid group-writable file fails closed like any other invalid file once it's used.
    writeFileSync(p.file, '{"readOnly": "yes"}');
    chmodSync(p.file, 0o664);
    expect(() => chooseWorkspace("side", p.dir)).toThrow(expect.objectContaining({ code: "invalid_project_file" }));
    expect(chooseWorkspace("side", p.dir, { ignoreInvalidProject: true }).ignoredProjectError).toMatch(/must be true or false/);
  });

  it("B-P2-4: a directory others can write to (without the sticky bit) makes its .slacker.json foreign", () => {
    const p = project({ workspace: "acme" });
    recordTrust(p.real, "acme");
    chmodSync(p.dir, 0o777);
    try {
      expect(foreignReason(p.file)).toBe(`is in ${p.dir}, which other users can write to (mode 777, no sticky bit)`);
      expect(projectWriteBlock(chooseWorkspace("acme", p.dir))).toMatchObject({ code: "untrusted_project" });
      chmodSync(p.dir, 0o1777);
      expect(foreignReason(p.file)).toBeUndefined();
      expect(chooseWorkspace(undefined, p.dir)).toMatchObject({ source: "project", projectTrusted: true });
    } finally {
      chmodSync(p.dir, 0o700);
    }
  });

  it("B-P2-4: the file is checked and read through one descriptor; a FIFO doesn't block", () => {
    const p = project({ workspace: "acme" });
    expect(inspectOwnedFile(p.file, true)).toEqual({ text: JSON.stringify({ workspace: "acme" }) });
    expect(inspectOwnedFile(p.file)).toEqual({});
    const fifoDir = mkdtempSync(join(root, "fifo-"));
    execFileSync("mkfifo", [join(fifoDir, ".slacker.json")]);
    expect(inspectOwnedFile(join(fifoDir, ".slacker.json"), true)).toMatchObject({ reason: "is not a regular file" });
    expect(chooseWorkspace(undefined, fifoDir).foreignProject?.reason).toBe("is not a regular file");
  });

  it("B-P2-7: a trust file others could write is refused (invalid_trust_file): nothing counts as trusted", () => {
    const p = project({ workspace: "acme" });
    recordTrust(p.real, "acme");
    const trustFile = process.env.SLACKER_TRUST_FILE!;
    expect(chooseWorkspace(undefined, p.dir).projectTrusted).toBe(true);
    for (const m of [0o660, 0o606]) {
      chmodSync(trustFile, m);
      expect(() => loadTrust(trustFile)).toThrow(expect.objectContaining({ code: "invalid_trust_file", message: expect.stringContaining("so someone else could have added trust records") }));
      const c = chooseWorkspace(undefined, p.dir);
      expect(c).toMatchObject({ projectTrusted: false, trustError: expect.stringContaining(`Ignoring the trust file ${trustFile}`) });
      expect(projectWriteBlock(c)).toMatchObject({ code: "untrusted_project" });
      expect(() => recordTrust(p.real, "acme")).toThrow(expect.objectContaining({ code: "invalid_trust_file" }));
    }
    chmodSync(trustFile, 0o600);
    expect(chooseWorkspace(undefined, p.dir).projectTrusted).toBe(true);
  });

  it("B-P2-5: trust keys are canonical realpaths (realpathSync.native), so case variants match", () => {
    const p = project({ workspace: "acme" });
    expect(trustKey(p.file)).toBe(realpathSync.native(p.file));
    expect(trustKey(join(p.dir, "missing.json"))).toBe(join(realpathSync.native(p.dir), "missing.json"));
    const upper = p.file.toUpperCase();
    if (existsSync(upper)) {
      // Case-insensitive file system: every spelling has one key.
      expect(trustKey(upper)).toBe(trustKey(p.file));
      expect(findProjectSettings(p.dir.toUpperCase())?.realFile).toBe(trustKey(p.file));
    }
  });

  it("D3: recheckWriteBlock re-reads the file and the trust store on every call", () => {
    const p = project({ workspace: "acme" });
    const start = chooseWorkspace(undefined, p.dir);
    expect(recheckWriteBlock(start, { cwd: p.dir })).toMatchObject({ code: "untrusted_project" });
    recordTrust(p.real, "acme");
    expect(recheckWriteBlock(start, { cwd: p.dir })).toBeUndefined();
    removeTrust(p.real);
    expect(recheckWriteBlock(start, { cwd: p.dir })?.message).toContain("To use a different workspace for one command, pass -w <name>.");
    expect(recheckWriteBlock(start, { cwd: p.dir, surface: "mcp" })?.message).toContain("Ask the user to check it and run `slacker trust` in");
    recordTrust(p.real, "acme");
    writeFileSync(p.file, "{oops");
    expect(recheckWriteBlock(start, { cwd: p.dir })).toMatchObject({ code: "invalid_project_file" });
    // -w: the file's workspace doesn't matter, but a file appearing later still can't take over.
    rmSync(p.file);
    const flagged = chooseWorkspace("side", p.dir);
    expect(recheckWriteBlock(flagged, { cwd: p.dir, flag: "side" })).toBeUndefined();
    writeFileSync(p.file, JSON.stringify({ readOnly: true }));
    expect(recheckWriteBlock(flagged, { cwd: p.dir, flag: "side" })).toMatchObject({ code: "read_only" });
  });

  it("a .slacker.json that isn't a regular file is foreign (never read)", () => {
    const dir = mkdtempSync(join(root, "trust-proj-"));
    mkdirSync(join(dir, ".slacker.json"));
    expect(foreignReason(join(dir, ".slacker.json"))).toBe("is not a regular file");
    expect(chooseWorkspace(undefined, dir).foreignProject?.reason).toBe("is not a regular file");
  });

  it("an owned symlink to an owned file is fine and trust is keyed by the realpath", () => {
    const p = project({ workspace: "acme" });
    const linkDir = mkdtempSync(join(root, "trust-link-"));
    symlinkSync(p.file, join(linkDir, ".slacker.json"));
    recordTrust(p.real, "acme");
    expect(chooseWorkspace(undefined, linkDir)).toMatchObject({ source: "project", projectTrusted: true, projectFile: join(linkDir, ".slacker.json") });
  });
});

describe("writeFileAtomic clearBits", () => {
  it("drops the given bits from an existing file's mode", () => {
    const dir = join(root, `clear${++n}`);
    mkdirSync(dir);
    const file = join(dir, ".slacker.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o666);
    writeFileAtomic(file, '{"workspace":"w"}', 0o644, { clearBits: 0o022 });
    expect(mode(file)).toBe(0o644);
  });
});
