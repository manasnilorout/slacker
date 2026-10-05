import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// init finds "the slacker on PATH" by comparing it with this install's entry; point that at a temp file.
const fake = vi.hoisted(() => ({ entry: "" }));
vi.mock("../src/command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/command.js")>()),
  entryPath: () => fake.entry,
}));

import { recordTrust, trustedWorkspace, trustKey } from "../src/config.js";
import { initProject, InitOpts } from "../src/init.js";
import { DEFAULT_IDENTITY, installSlackStub, restoreAll, TempConfig, writeTempConfig } from "./helpers/slackStub.js";

const savedPath = process.env.PATH;
const savedWorkspace = process.env.SLACKER_WORKSPACE;
let root: string;
let cfg: TempConfig;
let cwd: string;
let bin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slacker-init-"));
  mkdirSync(join(root, "slacker", "dist"), { recursive: true });
  fake.entry = join(root, "slacker", "dist", "index.js");
  writeFileSync(fake.entry, "#!/usr/bin/env node\n");
  bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(fake.entry, join(bin, "slacker")); // what npm link creates
  cwd = join(root, "project");
  mkdirSync(cwd);
  cfg = writeTempConfig();
  delete process.env.SLACKER_WORKSPACE;
});

afterEach(() => {
  restoreAll();
  cfg.cleanup();
  rmSync(root, { recursive: true, force: true });
  process.env.PATH = savedPath;
  if (savedWorkspace === undefined) delete process.env.SLACKER_WORKSPACE;
  else process.env.SLACKER_WORKSPACE = savedWorkspace;
});

const init = (o: InitOpts) => initProject(["work"], o, { configFile: cfg.file, cwd, execPath: process.execPath, nodeCandidates: [] });

describe("init with slacker on PATH (F3)", () => {
  it("writes the absolute path of that slacker, not a bare name GUI clients can't find", async () => {
    installSlackStub();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const r = await init({ mcp: true });
    const command = join(bin, "slacker");
    expect(r.servers[0]).toMatchObject({ command, args: ["serve", "--workspace", "work", "--config", cfg.file] });
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8")).mcpServers.slacker.command).toBe(command);
    expect(r.claudeMcpAdd[0]).toContain(`-- ${command} serve --workspace work`);
  });

  it("a rerun still recognises the entry as slacker's (no --replace needed)", async () => {
    installSlackStub();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    await init({ mcp: true });
    const again = await init({ mcp: true });
    expect(again.servers[0].replaced).toBe(true);
    expect(again.overridden).toEqual([]);
  });

  it("--command slacker is kept as given", async () => {
    installSlackStub();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect((await init({ mcp: true, command: "slacker" })).servers[0].command).toBe("slacker");
  });

  it("without slacker on PATH: node + entry", async () => {
    installSlackStub();
    process.env.PATH = "/usr/bin:/bin";
    expect((await init({ mcp: true })).servers[0]).toMatchObject({ command: process.execPath, args: [fake.entry, "serve", "--workspace", "work", "--config", cfg.file] });
  });
});

describe("init refuses symlinks that lead outside the project (unsafe_symlink)", () => {
  const ORIGINAL = '{"mcpServers": {"keep": {"command": "x"}}, "secret": "do not touch"}\n';
  let outside: string;

  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
    outside = join(root, "home");
    mkdirSync(outside);
    installSlackStub();
  });

  /** A user file outside the project, e.g. ~/.claude.json. */
  function victim(name = "claude.json"): string {
    const file = join(outside, name);
    writeFileSync(file, ORIGINAL);
    return file;
  }

  it.each([
    [".mcp.json", { mcp: true }],
    [".slacker.json", { mcp: true }],
    [".slacker.json", {}],
    [".slacker.json", { mcpOnly: true }],
  ] as const)("%s → a file outside (%o): refused, nothing written, target untouched", async (name, o) => {
    const target = victim();
    const mtime = statSync(target).mtimeMs;
    symlinkSync(target, join(cwd, name));
    await expect(init(o)).rejects.toMatchObject({ code: "unsafe_symlink", message: expect.stringContaining(`${join(cwd, name)} is a symlink to ${realpathSync(target)}`) });
    expect(readFileSync(target, "utf-8")).toBe(ORIGINAL);
    expect(statSync(target).mtimeMs).toBe(mtime);
    expect(lstatSync(join(cwd, name)).isSymbolicLink()).toBe(true);
    // The other file isn't written either.
    const other = name === ".mcp.json" ? ".slacker.json" : ".mcp.json";
    expect(existsSync(join(cwd, other))).toBe(false);
    expect(trustedWorkspace(realpathSync(target))).toBeUndefined();
  });

  it("a symlink to the real config.json is refused too", async () => {
    symlinkSync(cfg.file, join(cwd, ".slacker.json"));
    const before = readFileSync(cfg.file, "utf-8");
    await expect(init({})).rejects.toMatchObject({ code: "unsafe_symlink" });
    expect(readFileSync(cfg.file, "utf-8")).toBe(before);
  });

  it("a relative symlink climbing out of the project is refused", async () => {
    victim();
    symlinkSync("../home/claude.json", join(cwd, ".mcp.json"));
    await expect(init({ mcp: true })).rejects.toMatchObject({ code: "unsafe_symlink" });
    expect(readFileSync(join(outside, "claude.json"), "utf-8")).toBe(ORIGINAL);
  });

  it("a dangling symlink is refused", async () => {
    symlinkSync(join(outside, "does-not-exist.json"), join(cwd, ".mcp.json"));
    await expect(init({ mcp: true })).rejects.toMatchObject({ code: "unsafe_symlink", message: expect.stringMatching(/target doesn't exist/) });
    expect(existsSync(join(outside, "does-not-exist.json"))).toBe(false);
  });

  it("a symlink inside the project that isn't a regular file is refused", async () => {
    mkdirSync(join(cwd, "configs"));
    symlinkSync(join(cwd, "configs"), join(cwd, ".mcp.json"));
    await expect(init({ mcp: true })).rejects.toMatchObject({ code: "unsafe_symlink", message: expect.stringMatching(/not a regular file/) });
  });

  it("a project file that isn't a regular file is refused", async () => {
    mkdirSync(join(cwd, ".slacker.json"));
    await expect(init({})).rejects.toMatchObject({ code: "invalid_file", message: expect.stringMatching(/not a regular file/) });
  });

  it("symlinks that stay inside the project are written through", async () => {
    mkdirSync(join(cwd, "config"));
    writeFileSync(join(cwd, "config", "slacker.json"), '{"note": "kept"}');
    writeFileSync(join(cwd, "config", "mcp.json"), '{"mcpServers": {}}');
    symlinkSync(join(cwd, "config", "slacker.json"), join(cwd, ".slacker.json"));
    symlinkSync("config/mcp.json", join(cwd, ".mcp.json"));
    const r = await init({ mcp: true });
    expect(r.projectFile).toBe(join(cwd, ".slacker.json"));
    expect(lstatSync(join(cwd, ".slacker.json")).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, "config", "slacker.json"), "utf-8"))).toEqual({ note: "kept", workspace: "work" });
    expect(Object.keys(JSON.parse(readFileSync(join(cwd, "config", "mcp.json"), "utf-8")).mcpServers)).toEqual(["slacker"]);
    // Trust is recorded for the file the link resolves to.
    expect(trustedWorkspace(realpathSync(join(cwd, "config", "slacker.json")))).toBe("work");
  });

  it("B-P2-1: a symlink to a project file whose name starts with \"..\" stays inside the project", async () => {
    writeFileSync(join(cwd, "..real.json"), '{"note": "kept"}');
    writeFileSync(join(cwd, "..mcp.json"), "{}");
    symlinkSync("..real.json", join(cwd, ".slacker.json"));
    symlinkSync(join(cwd, "..mcp.json"), join(cwd, ".mcp.json"));
    await init({ mcp: true });
    expect(JSON.parse(readFileSync(join(cwd, "..real.json"), "utf-8"))).toEqual({ note: "kept", workspace: "work" });
    expect(Object.keys(JSON.parse(readFileSync(join(cwd, "..mcp.json"), "utf-8")).mcpServers)).toEqual(["slacker"]);
    // "../x" still climbs out.
    rmSync(join(cwd, ".slacker.json"));
    symlinkSync("../home/claude.json", join(cwd, ".slacker.json"));
    victim();
    await expect(init({})).rejects.toMatchObject({ code: "unsafe_symlink" });
  });

  it("works when the project directory itself is reached through a symlink", async () => {
    const linked = join(root, "linked-project");
    symlinkSync(cwd, linked);
    const r = await initProject(["work"], { mcp: true }, { configFile: cfg.file, cwd: linked, execPath: process.execPath, nodeCandidates: [] });
    expect(r.projectFile).toBe(join(linked, ".slacker.json"));
    expect(JSON.parse(readFileSync(join(cwd, ".slacker.json"), "utf-8"))).toEqual({ workspace: "work" });
  });
});

describe("init records trust and never leaves .slacker.json writable by others", () => {
  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
    installSlackStub();
  });

  it("trusts the .slacker.json it writes for that workspace; --mcp-only records nothing", async () => {
    const r = await init({});
    expect(r.trustFile).toBe(process.env.SLACKER_TRUST_FILE);
    expect(trustedWorkspace(realpathSync(join(cwd, ".slacker.json")))).toBe("work");
    rmSync(join(cwd, ".slacker.json"));
    const only = await init({ mcpOnly: true });
    expect(only.trustFile).toBeNull();
    expect(existsSync(join(cwd, ".slacker.json"))).toBe(false);
  });

  it("drops group/world write bits from an existing file", async () => {
    const file = join(cwd, ".slacker.json");
    writeFileSync(file, '{"workspace": "work"}');
    chmodSync(file, 0o666);
    await init({});
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });
});

describe("D1: bare init never trusts a .slacker.json you haven't trusted", () => {
  const bare = (o: InitOpts = {}, workspaceFlag?: string) =>
    initProject([], o, { configFile: cfg.file, cwd, execPath: process.execPath, nodeCandidates: [], workspaceFlag });
  const file = () => join(cwd, ".slacker.json");
  const firstLine = (e: unknown) => String((e as Error).message).split("\n")[0]; // then the "(run slacker as: …)" note

  beforeEach(() => {
    process.env.PATH = "/usr/bin:/bin";
    cfg.cleanup();
    cfg = writeTempConfig({ work: {}, side: { token: "xoxc-side", teamId: "T0SIDE001" } }, "work");
  });
  /** auth.test answers per token, so both workspaces pass init's live check. */
  const stub = () =>
    installSlackStub().on("auth.test", (_p, call) =>
      call.headers.authorization?.includes("xoxc-side") ? { ...DEFAULT_IDENTITY, team: "Side", team_id: "T0SIDE001" } : DEFAULT_IDENTITY
    );

  it.each([
    [{}, ""],
    [{ mcp: true }, " --mcp"],
    [{ mcpOnly: true }, " --mcp-only"],
  ] as const)("refuses (untrusted_project) a workspace taken from an untrusted file (%o), writing nothing", async (o, flag) => {
    const slack = stub();
    writeFileSync(file(), JSON.stringify({ workspace: "side" }));
    const e = await bare(o).catch((x) => x);
    expect(e).toMatchObject({ code: "untrusted_project", hint: expect.stringContaining(`slacker init side${flag}`) });
    expect(firstLine(e)).toBe(
      `.slacker.json at ${file()} says workspace "side", but you haven't trusted it on this machine. ` +
        `Check that it's right, then name it explicitly: slacker init side${flag}. Nothing was written.`
    );
    expect(readFileSync(file(), "utf-8")).toBe(JSON.stringify({ workspace: "side" }));
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
    expect(trustedWorkspace(trustKey(file()))).toBeUndefined();
    expect(slack.count()).toBe(0);
  });

  it("says why when the file was trusted for another workspace, or someone else could have changed it", async () => {
    stub();
    writeFileSync(file(), JSON.stringify({ workspace: "side" }));
    recordTrust(trustKey(file()), "work");
    expect(firstLine(await bare().catch((x) => x))).toContain(`but you haven't trusted it on this machine (you trusted it for workspace "work"). Check`);
    recordTrust(trustKey(file()), "side");
    chmodSync(file(), 0o664);
    expect(firstLine(await bare().catch((x) => x))).toContain("but you haven't trusted it on this machine: it is writable by its group (mode 664). Check");
  });

  it("works as before when the file is trusted for that workspace, or the workspace is named", async () => {
    stub();
    writeFileSync(file(), JSON.stringify({ workspace: "side" }));
    expect((await initProject(["side"], {}, { configFile: cfg.file, cwd, execPath: process.execPath, nodeCandidates: [] })).workspace).toBe("side");
    expect(trustedWorkspace(trustKey(file()))).toBe("side");
    const again = await bare({ readOnly: true });
    expect(again).toMatchObject({ workspace: "side", readOnly: true });
    // -w / SLACKER_WORKSPACE name it too.
    writeFileSync(file(), JSON.stringify({ workspace: "work" }));
    expect((await bare({}, "side")).workspace).toBe("side");
    process.env.SLACKER_WORKSPACE = "side";
    writeFileSync(file(), JSON.stringify({ workspace: "work" }));
    expect((await bare()).workspace).toBe("side");
  });

  it("no .slacker.json: falls back to defaultWorkspace as before", async () => {
    stub();
    expect((await bare()).workspace).toBe("work");
    expect(trustedWorkspace(trustKey(file()))).toBe("work");
  });
});
