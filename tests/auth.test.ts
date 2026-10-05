import { describe, it, expect, afterAll, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authAdd, authDefault, authList, authRefresh, authRemove, authRename, authSetup } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const root = mkdtempSync(join(tmpdir(), "slacker-auth-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Identity {
  team: string;
  team_id: string;
  user: string;
  user_id: string;
}

/** Fake auth.test: each token maps to an identity; unknown tokens are invalid_auth. */
function stubSlack(identities: Record<string, Identity>) {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const token = (init!.headers as Record<string, string>).Authorization.replace("Bearer ", "");
    const id = identities[token];
    const body = id
      ? { ok: true, ...id, url: `https://${id.team.toLowerCase().replace(/\W+/g, "")}.slack.com/` }
      : { ok: false, error: "invalid_auth" };
    return new Response(JSON.stringify(body));
  }) as typeof fetch;
}

const acme: Identity = { team: "Acme", team_id: "T1", user: "me", user_id: "U1" };
const other: Identity = { team: "Acme", team_id: "T9", user: "me", user_id: "U9" };

let n = 0;
function tempConfig(content?: unknown): string {
  const dir = join(root, `c${++n}`);
  mkdirSync(dir);
  const file = join(dir, "config.json");
  if (content !== undefined) writeFileSync(file, JSON.stringify(content));
  return file;
}

const entry = (teamId: string, extra: Record<string, unknown> = {}) => ({
  token: `xoxc-old-${teamId}`,
  cookie: "xoxd-old",
  url: "https://x.slack.com/",
  userId: "U1",
  teamId,
  ...extra,
});
const extract = (tokens: string[], cookie: string | null = "xoxd-fresh") => () => ({ tokens, cookie });

describe("authSetup", () => {
  it("never overwrites a name held by a different team (suffixes instead)", async () => {
    const file = tempConfig({ workspaces: { acme: entry("T9", { userId: "U9" }) }, defaultWorkspace: "acme" });
    stubSlack({ "xoxc-a": acme });
    const r = await authSetup(file, { extract: extract(["xoxc-a"]) });
    expect(r.workspaces).toEqual([{ name: "acme-2", team: "Acme", teamId: "T1", user: "me", updated: false }]);
    expect(r.warnings[0]).toMatch(/"acme" is already taken.*saved as "acme-2"/);
    const config = loadConfig(file);
    expect(config.workspaces.acme.teamId).toBe("T9");
    expect(config.workspaces["acme-2"]).toMatchObject({ teamId: "T1", token: "xoxc-a", cookie: "xoxd-fresh" });
  });

  it("updates the existing entry for the same team, preferring the slug name, and warns about aliases", async () => {
    const file = tempConfig({ workspaces: { work: entry("T1"), acme: entry("T1", { extra: "kept" }) }, defaultWorkspace: "work" });
    stubSlack({ "xoxc-a": acme });
    const r = await authSetup(file, { extract: extract(["xoxc-a"]) });
    expect(r.workspaces).toMatchObject([{ name: "acme", updated: true }]);
    expect(r.warnings[0]).toMatch(/"acme", "work" all point at team "Acme"/);
    const config = loadConfig(file);
    expect(config.workspaces.acme).toMatchObject({ token: "xoxc-a", extra: "kept" });
    expect(config.workspaces.work.token).toBe("xoxc-old-T1");
  });

  it("names a team with no Latin letters after its team id", async () => {
    const file = tempConfig();
    stubSlack({ "xoxc-j": { team: "日本チーム", team_id: "TJP123", user: "me", user_id: "U5" } });
    const r = await authSetup(file, { extract: extract(["xoxc-j"]) });
    expect(r.workspaces[0].name).toBe("tjp123");
    expect(loadConfig(file).defaultWorkspace).toBe("tjp123");
  });

  it("strips accents for the slug", async () => {
    const file = tempConfig();
    stubSlack({ "xoxc-c": { team: "Café Ünited", team_id: "TC", user: "me", user_id: "U5" } });
    expect((await authSetup(file, { extract: extract(["xoxc-c"]) })).workspaces[0].name).toBe("cafe-united");
  });

  it("reports failing tokens without leaking them", async () => {
    const file = tempConfig();
    stubSlack({ "xoxc-a": acme });
    const r = await authSetup(file, { extract: extract(["xoxc-a", "xoxc-stale-0123456789"]) });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].token).not.toContain("0123456789");
    expect(r.failures[0].error).toMatch(/invalid_auth/);
  });

  it("explains a missing cookie", async () => {
    await expect(authSetup(tempConfig(), { extract: () => ({ tokens: ["xoxc-a"], cookie: null, cookieError: "Keychain denied" }) })).rejects.toThrow(
      /Keychain denied.*auth add/
    );
  });
});

describe("authRefresh", () => {
  it("updates only entries whose team and user match a live desktop session", async () => {
    const file = tempConfig({
      workspaces: {
        acme: entry("T1", { note: "kept" }),
        manual: entry("T7", { cookie: "xoxd-manual" }), // added by hand from a browser session
        otheruser: entry("T1", { userId: "U2" }),
      },
      defaultWorkspace: "acme",
    });
    stubSlack({ "xoxc-new-a": acme });
    const r = await authRefresh(file, { extract: extract(["xoxc-new-a", "xoxc-dead"]) });

    expect(r.refreshed).toEqual(["acme"]);
    expect(r.untouched.map((u) => u.name)).toEqual(["manual", "otheruser"]);
    expect(r.untouched[1].reason).toMatch(/different user/);
    expect(r.failures).toHaveLength(1);

    const config = loadConfig(file);
    expect(config.workspaces.acme).toMatchObject({ token: "xoxc-new-a", cookie: "xoxd-fresh", note: "kept" });
    expect(config.workspaces.manual).toMatchObject({ token: "xoxc-old-T7", cookie: "xoxd-manual" });
    expect(config.workspaces.otheruser.cookie).toBe("xoxd-old");
  });

  it("does not rewrite the file when nothing matched", async () => {
    const file = tempConfig({ workspaces: { manual: entry("T7") }, defaultWorkspace: "manual" });
    const before = readFileSync(file, "utf-8");
    stubSlack({ "xoxc-a": acme });
    const r = await authRefresh(file, { extract: extract(["xoxc-a"]) });
    expect(r.refreshed).toEqual([]);
    expect(readFileSync(file, "utf-8")).toBe(before);
  });
});

describe("authAdd", () => {
  it("refuses to replace a different team without force", async () => {
    const file = tempConfig({ workspaces: { work: entry("T9") }, defaultWorkspace: "work" });
    stubSlack({ "xoxc-a": acme });
    await expect(authAdd(file, "work", "xoxc-a", "xoxd-a")).rejects.toThrow(/already configured for team T9.*--force/);
    expect(loadConfig(file).workspaces.work.teamId).toBe("T9");

    const r = await authAdd(file, "work", "xoxc-a", "d=xoxd-a", { force: true });
    expect(r).toMatchObject({ workspace: "work", teamId: "T1", updated: true, replaced: true });
    expect(loadConfig(file).workspaces.work).toMatchObject({ teamId: "T1", cookie: "xoxd-a" });
  });

  it("updates the same team and warns about aliases", async () => {
    const file = tempConfig({ workspaces: { work: entry("T1"), copy: entry("T1") }, defaultWorkspace: "work" });
    stubSlack({ "xoxc-a": acme });
    const r = await authAdd(file, "work", "xoxc-a", "xoxd-a");
    expect(r).toMatchObject({ updated: true, replaced: false });
    expect(r.warnings[0]).toMatch(/"copy"/);
  });

  it("validates inputs before calling Slack", async () => {
    const file = tempConfig();
    await expect(authAdd(file, "__proto__", "xoxc-a", "xoxd-a")).rejects.toThrow(/Invalid workspace name/);
    await expect(authAdd(file, "w", "nope", "xoxd-a")).rejects.toThrow(/xoxc-/);
    await expect(authAdd(file, "w", "xoxc-a", " ")).rejects.toThrow(/cookie is empty/);
  });
});

describe("authRemove / authRename / authDefault", () => {
  const config = () => ({ workspaces: { work: entry("T1"), side: entry("T2") }, defaultWorkspace: "work", extra: true });

  it("removes a workspace and clears the default pointer with a note", () => {
    const file = tempConfig(config());
    const r = authRemove(file, "work");
    expect(r).toMatchObject({ removed: "work", defaultWorkspace: null });
    expect(r.notes[0]).toMatch(/was the default.*auth default <name>.*side/);
    const saved = loadConfig(file);
    expect(Object.keys(saved.workspaces)).toEqual(["side"]);
    expect(saved).toMatchObject({ defaultWorkspace: null, extra: true });
  });

  it("removing a non-default keeps the default", () => {
    const file = tempConfig(config());
    expect(authRemove(file, "side").defaultWorkspace).toBe("work");
  });

  it("refuses unknown and prototype names", () => {
    const file = tempConfig(config());
    expect(() => authRemove(file, "nope")).toThrow(/not found. Available: work, side/);
    expect(() => authRemove(file, "constructor")).toThrow(/not found/);
    expect(() => authDefault(file, "constructor")).toThrow(/not found/);
    expect(() => authRename(file, "toString", "x")).toThrow(/not found/);
  });

  it("renames in place and follows the default pointer", () => {
    const file = tempConfig(config());
    const r = authRename(file, "work", "acme");
    expect(r).toMatchObject({ renamed: { from: "work", to: "acme" }, defaultWorkspace: "acme" });
    const saved = loadConfig(file);
    expect(Object.keys(saved.workspaces)).toEqual(["acme", "side"]);
    expect(saved.workspaces.acme.teamId).toBe("T1");
  });

  it("refuses to rename onto an existing or invalid name", () => {
    const file = tempConfig(config());
    expect(() => authRename(file, "work", "side")).toThrow(/already exists/);
    expect(() => authRename(file, "work", "__proto__")).toThrow(/Invalid workspace name/);
    expect(() => authRename(file, "work", "work")).toThrow(/already called/);
  });
});

describe("authList", () => {
  it("flags duplicate teams, team mismatches and loose permissions", async () => {
    const file = tempConfig({
      workspaces: { "curly-braces": entry("T1", { token: "xoxc-a" }), uipath: entry("T1", { token: "xoxc-a" }), mislabeled: entry("T5", { token: "xoxc-o" }) },
      defaultWorkspace: "uipath",
    });
    chmodSync(file, 0o644);
    stubSlack({ "xoxc-a": acme, "xoxc-o": other });
    const r = await authList(file);
    expect(r.duplicates).toEqual([["curly-braces", "uipath"]]);
    expect(r.workspaces.find((w) => w.name === "uipath")).toMatchObject({ ok: true, default: true, teamId: "T1" });
    expect(r.warnings.join("\n")).toMatch(/"curly-braces", "uipath" all point at the same Slack team/);
    expect(r.warnings.join("\n")).toMatch(/"mislabeled" is configured for team T5 but its credentials sign in to "Acme" \(T9\)/);
    expect(r.warnings.join("\n")).toMatch(/mode 644.*chmod 600/);
  });
});

describe("authSetup default workspace", () => {
  it("does not pick a default when the config already had workspaces", async () => {
    const file = tempConfig({ workspaces: { side: entry("T9", { userId: "U9" }) }, defaultWorkspace: null });
    stubSlack({ "xoxc-a": acme });
    const r = await authSetup(file, { extract: extract(["xoxc-a"]) });
    expect(r.defaultWorkspace).toBeNull();
    expect(loadConfig(file).defaultWorkspace).toBeNull();
    expect(r.notes.join("\n")).toMatch(/No default workspace is set — pick one with: .+ auth default <name> \(available: side, acme\)/);
  });

  it("keeps an existing default without notes", async () => {
    const file = tempConfig({ workspaces: { side: entry("T9", { userId: "U9" }) }, defaultWorkspace: "side" });
    stubSlack({ "xoxc-a": acme });
    const r = await authSetup(file, { extract: extract(["xoxc-a"]) });
    expect(r).toMatchObject({ defaultWorkspace: "side", notes: [] });
  });

  it("picks the first imported workspace for an empty config and says so", async () => {
    const file = tempConfig();
    stubSlack({ "xoxc-a": acme, "xoxc-b": other });
    const r = await authSetup(file, { extract: extract(["xoxc-a", "xoxc-b"]) });
    expect(r.workspaces.map((w) => w.name)).toEqual(["acme", "acme-2"]);
    expect(r.defaultWorkspace).toBe("acme");
    expect(loadConfig(file).defaultWorkspace).toBe("acme");
    expect(r.notes[0]).toMatch(/"acme" is now the default workspace\. Change it with: .+ auth default <name>/);
  });

  it("writes nothing when no token works", async () => {
    const file = tempConfig();
    stubSlack({});
    const r = await authSetup(file, { extract: extract(["xoxc-dead"]) });
    expect(r).toMatchObject({ workspaces: [], defaultWorkspace: null, notes: [] });
    expect(existsSync(file)).toBe(false);
  });
});

describe("authAdd default workspace", () => {
  it("does not silently make an added workspace the default", async () => {
    const file = tempConfig({ workspaces: { side: entry("T9") }, defaultWorkspace: null });
    stubSlack({ "xoxc-a": acme });
    const r = await authAdd(file, "work", "xoxc-a", "xoxd-a");
    expect(r.defaultWorkspace).toBeNull();
    expect(r.notes[0]).toMatch(/No default workspace is set/);
  });

  it("makes the first workspace the default", async () => {
    const file = tempConfig();
    stubSlack({ "xoxc-a": acme });
    expect(await authAdd(file, "work", "xoxc-a", "xoxd-a")).toMatchObject({ defaultWorkspace: "work" });
  });
});

describe("auth mutations take the config lock", () => {
  /** A stale lock is only cleaned up by code that goes through updateConfig. */
  function staleLock(file: string): string {
    const lock = `${file}.lock`;
    writeFileSync(lock, "crashed");
    const old = new Date(Date.now() - 20_000);
    utimesSync(lock, old, old);
    return lock;
  }
  const config = () => ({ workspaces: { work: entry("T1"), side: entry("T2") }, defaultWorkspace: "work" });

  it.each([
    ["default", (f: string) => authDefault(f, "side")],
    ["remove", (f: string) => authRemove(f, "side")],
    ["rename", (f: string) => authRename(f, "side", "other")],
  ])("auth %s", (_label, run) => {
    const file = tempConfig(config());
    const lock = staleLock(file);
    run(file);
    expect(existsSync(lock)).toBe(false);
  });

  it.each([
    ["setup", (f: string) => authSetup(f, { extract: extract(["xoxc-a"]) })],
    ["refresh", (f: string) => authRefresh(f, { extract: extract(["xoxc-a"]) })],
    ["add", (f: string) => authAdd(f, "new", "xoxc-a", "xoxd-a")],
  ])("auth %s", async (_label, run) => {
    const file = tempConfig(config());
    const lock = staleLock(file);
    stubSlack({ "xoxc-a": acme });
    await run(file);
    expect(existsSync(lock)).toBe(false);
  });

  it("validates against the freshly loaded config", () => {
    const file = tempConfig(config());
    authRemove(file, "side");
    expect(() => authRename(file, "side", "x")).toThrow(/not found/);
  });
});
