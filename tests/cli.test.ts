import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

vi.mock("../src/server.js", () => ({ startServer: vi.fn(async () => {}) }));

import { startServer } from "../src/server.js";
import { CliIO, main } from "../src/cli.js";
import { entryPath } from "../src/command.js";
import { DEFAULT_IDENTITY, installSlackStub, makeUser, paginate, restoreAll, slackError, SlackStub, TempConfig, writeTempConfig } from "./helpers/slackStub.js";

const GENERAL = { id: "C0GENERAL1", name: "general" };
const SIDE_IDENTITY = { ...DEFAULT_IDENTITY, team: "Side", team_id: "T0SIDE001", url: "https://side.slack.com/" };
const LINK = "https://work.slack.com/archives/C0GENERAL1/p1700000000123456";
const QUOTE_ERROR = 'Quote the message: slacker send general "your message" (use -- before text that starts with -)';

const ENV_KEYS = ["SLACKER_READ_ONLY", "SLACKER_WORKSPACE", "SLACKER_CONFIG", "SLACK_TOKEN", "SLACK_COOKIE"];
/** No npm-linked slacker on PATH, so init's default command doesn't depend on this machine. */
const CLEAN_PATH = "/usr/bin:/bin";
const savedEnv = { ...process.env };
const cleanups: Array<() => void> = [];

let cfg: TempConfig;
let cwd: string;

function tempConfig(...args: Parameters<typeof writeTempConfig>): TempConfig {
  const c = writeTempConfig(...args);
  cleanups.push(() => c.cleanup());
  return c;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.PATH = CLEAN_PATH;
  cfg = tempConfig({ work: {}, side: { token: "xoxc-side-token", teamId: SIDE_IDENTITY.team_id, url: SIDE_IDENTITY.url } }, "work");
  cwd = mkdtempSync(join(tmpdir(), "slacker-cli-cwd-"));
  cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
  vi.mocked(startServer).mockClear();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  restoreAll();
  vi.restoreAllMocks();
  process.env = { ...savedEnv };
});

type Stdin = CliIO["stdin"];

function fakeStdin(text?: string, tty = false): PassThrough & { isTTY: boolean } {
  const s = new PassThrough();
  if (text !== undefined) s.end(text);
  return Object.assign(s, { isTTY: tty });
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process against the temp config (never the real one) and a temp cwd. */
async function run(args: string[], o: { stdin?: Stdin; cwd?: string; config?: string | null; io?: Partial<CliIO> } = {}): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ") + "\n")),
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ") + "\n")),
    vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => out.push(String(s)) > 0) as never),
    vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => err.push(String(s)) > 0) as never),
  ];
  let code = 0;
  const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => void (code = c ?? 0)) as never);
  const pre = o.config === null ? [] : ["-c", o.config ?? cfg.file];
  try {
    await main(["node", "slacker", ...pre, ...args], { stdin: o.stdin ?? fakeStdin(""), cwd: o.cwd ?? cwd, ...o.io });
  } finally {
    for (const s of spies) s.mockRestore();
    exit.mockRestore();
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

/** A workspace with #general; auth.test answers per token (work vs side). */
function slack(): SlackStub {
  return installSlackStub()
    .on("auth.test", (_p, call) => (call.headers.authorization?.includes("xoxc-side") ? SIDE_IDENTITY : DEFAULT_IDENTITY))
    .on("users.conversations", (p) => paginate([GENERAL], "channels", p))
    .on("conversations.list", (p) => paginate([GENERAL], "channels", p))
    .on("conversations.info", (p) => (p.channel === GENERAL.id ? { channel: GENERAL } : slackError("channel_not_found")));
}

const posted = (s: SlackStub) => s.callsTo("chat.postMessage").map((c) => c.params.text);
const WRITE_METHODS = ["chat.postMessage", "chat.update", "chat.delete", "reactions.add", "users.profile.set"];
const writes = (s: SlackStub) => s.calls.filter((c) => WRITE_METHODS.includes(c.method));
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

// ── D8: message text ─────────────────────────────────────

describe("send/edit text argument (D8, P0-3)", () => {
  it("sends option-looking words inside quoted text verbatim", async () => {
    const s = slack();
    const r = await run(["send", "general", "use the --json flag"]);
    expect(r.code).toBe(0);
    expect(posted(s)).toEqual(["use the --json flag"]);
    expect(r.stdout.trim().startsWith("{")).toBe(false); // --json inside the text didn't switch output mode
  });

  it("accepts text starting with - after --", async () => {
    const s = slack();
    expect((await run(["send", "general", "--", "-1 is wrong"])).code).toBe(0);
    expect(posted(s)).toEqual(["-1 is wrong"]);
  });

  it("-w inside the quoted text doesn't switch workspace", async () => {
    const s = slack();
    const r = await run(["send", "general", "please use -w side here"]);
    expect(r.code).toBe(0);
    expect(posted(s)).toEqual(["please use -w side here"]);
    expect(s.callsTo("chat.postMessage")[0].headers.authorization).toBe("Bearer xoxc-test-token");
    await run(["send", "general", "--", "-w side"]);
    expect(posted(s)[1]).toBe("-w side");
    expect(s.callsTo("chat.postMessage")[1].headers.authorization).toBe("Bearer xoxc-test-token");
  });

  it("refuses unquoted extra words", async () => {
    const s = slack();
    const r = await run(["send", "general", "use", "the", "flag"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(QUOTE_ERROR);
    expect(writes(s)).toEqual([]);
    expect((await run(["edit", LINK, "two", "words"])).stderr).toContain("Quote the message");
  });

  it("explains -- when text starting with - is taken for an option", async () => {
    slack();
    const r = await run(["send", "general", "-1 is wrong"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown option/);
    expect(r.stderr).toContain("Put -- before message text");
  });

  it('reads stdin only for "-", stripping CRLF and the trailing newline', async () => {
    const s = slack();
    expect((await run(["send", "general", "-"], { stdin: fakeStdin("line one\r\nline two\r\n\r\n") })).code).toBe(0);
    expect(posted(s)).toEqual(["line one\nline two"]);

    // A pipe that never closes is not read when the text is given.
    expect((await run(["send", "general", "hello"], { stdin: fakeStdin() })).code).toBe(0);
    expect(posted(s)[1]).toBe("hello");
  });

  it("rejects empty stdin and - from a terminal", async () => {
    const s = slack();
    expect((await run(["send", "general", "-"], { stdin: fakeStdin(" \n") })).stderr).toMatch(/stdin is empty/);
    expect((await run(["send", "general", "-"], { stdin: fakeStdin(undefined, true) })).stderr).toMatch(/stdin is a terminal/);
    expect(writes(s)).toEqual([]);
  });

  it("edit sends the exact text", async () => {
    const s = slack();
    expect((await run(["edit", LINK, "fixed --typo"])).code).toBe(0);
    expect(s.callsTo("chat.update")[0].params).toMatchObject({ channel: "C0GENERAL1", ts: "1700000000.123456", text: "fixed --typo" });
  });
});

// ── Write output, dry run, read-only ─────────────────────

describe("writes (D3, D4)", () => {
  it("prints the destination, team and workspace", async () => {
    slack();
    const r = await run(["send", "general", "hi"]);
    expect(r.stdout).toContain('→ #general · team "Work" (workspace "work")');
  });

  it("--dry-run resolves and verifies without posting", async () => {
    const s = slack();
    const r = await run(["send", "general", "--dry-run", "check this"]);
    expect(r.code).toBe(0);
    expect(s.count("chat.postMessage")).toBe(0);
    expect(s.count("auth.test")).toBe(1);
    expect(r.stdout).toContain('Would send to #general · team "Work" (workspace "work")');
    expect(r.stdout).toContain("  check this");
    expect(r.stdout).toContain("nothing was sent");
  });

  it("--broadcast maps to reply_broadcast for thread replies", async () => {
    const s = slack();
    expect((await run(["send", LINK, "fyi", "--broadcast"])).code).toBe(0);
    expect(s.callsTo("chat.postMessage")[0].params).toMatchObject({ thread_ts: "1700000000.123456", reply_broadcast: "true" });
    expect((await run(["send", "general", "fyi", "--broadcast"])).stderr).toMatch(/only applies to thread replies/);
  });

  it("--json prints the result object", async () => {
    slack();
    const r = await run(["--json", "send", "general", "hi"]);
    expect(JSON.parse(r.stdout)).toMatchObject({ sent: true, workspace: "work", team: "Work", destination: { name: "#general" } });
  });

  const writeCommands = [
    ["send", "general", "hi"],
    ["edit", LINK, "new"],
    ["delete", LINK, "--yes"],
    ["react", LINK, "eyes"],
    ["status", "--set", "lunch"],
    ["status", "--clear"],
  ];

  it("refuses every write in a read-only project (.slacker.json)", async () => {
    const s = slack();
    writeFileSync(join(cwd, ".slacker.json"), JSON.stringify({ workspace: "work", readOnly: true }));
    for (const args of writeCommands) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("read-only");
    }
    expect(writes(s)).toEqual([]);
  });

  it("refuses every write with SLACKER_READ_ONLY=yes", async () => {
    const s = slack();
    process.env.SLACKER_READ_ONLY = "yes";
    for (const args of writeCommands) {
      const r = await run(args);
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toContain("SLACKER_READ_ONLY");
    }
    expect(writes(s)).toEqual([]);
  });

  it("delete without a TTY needs --yes", async () => {
    const s = slack();
    const r = await run(["delete", LINK]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Pass --yes");
    expect(s.count("chat.delete")).toBe(0);
    expect((await run(["delete", LINK, "--yes"])).stdout).toContain("✓ Deleted");
  });
});

// ── Errors and --json ────────────────────────────────────

describe("errors (P2-10)", () => {
  it("--json errors go to stdout as {error} with exit 1", async () => {
    slack();
    const r = await run(["--json", "read", "nosuch"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).error.message).toMatch(/No channel named "#nosuch"/);
  });

  it("includes the Slack error code and hint", async () => {
    slack().fail("conversations.history", "invalid_auth");
    const r = await run(["read", "C0GENERAL1", "--json"]);
    const { error } = JSON.parse(r.stdout);
    expect(error).toMatchObject({ code: "invalid_auth", message: "Slack API error (conversations.history): invalid_auth" });
    expect(error.hint).toMatch(/auth refresh/);
  });

  it("commander errors honor --json too", async () => {
    const r = await run(["--json", "read", "general", "-n", "abc"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "commander.invalidArgument", message: expect.stringMatching(/whole number from 1 to 200/) });
  });

  it("without --json errors go to stderr prefixed with slacker:", async () => {
    slack();
    const r = await run(["read", "nosuch"]);
    expect(r).toMatchObject({ code: 1, stdout: "" });
    expect(r.stderr).toMatch(/^slacker: No channel named/);
  });
});

describe("numbers and enums (P2-7)", () => {
  it.each([
    ["read", "general", "-n", "10abc"],
    ["read", "general", "-n", "1e3"],
    ["read", "general", "-n", "0"],
    ["read", "general", "-n", "201"],
    ["read", "general", "-n", "-5"],
    ["thread", LINK, "-n", "1001"],
    ["search", "x", "-n", "101"],
    ["search", "x", "--page", "0"],
    ["search", "x", "--sort", "bogus"],
    ["channels", "-n", "1001"],
    ["unread", "-n", "101"],
    ["users", "-n", "201"],
    ["status", "--set", "x", "--expires", "-10"],
    ["status", "--set", "x", "--expires", "525601"],
  ])("rejects %s %s %s %s", async (...args) => {
    const s = slack();
    const r = await run(args);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/whole number|Allowed choices/);
    expect(s.count()).toBe(0);
  });

  it("accepts in-range values", async () => {
    const s = slack();
    s.on("search.messages", (p) => ({ messages: { matches: [], total: 0, paging: { page: Number(p.page), pages: 1 } } }));
    expect((await run(["read", "general", "-n", "200"])).code).toBe(0);
    expect(s.callsTo("conversations.history")[0].params.limit).toBe("200");
    expect((await run(["search", "x", "--sort", "score", "--page", "2"])).code).toBe(0);
    expect(s.callsTo("search.messages")[0].params).toMatchObject({ sort: "score", page: "2" });
  });

  it("users: at most 50 with a query, 200 when listing", async () => {
    const s = slack();
    expect((await run(["users", "alice", "-n", "51"])).stderr).toMatch(/at most 50/);
    expect((await run(["users", "-n", "200"])).code).toBe(0);
    expect(s.callsTo("users.list")[0].params.limit).toBe("200");
  });
});

describe("status (P2-8)", () => {
  it("refuses to set someone else's status", async () => {
    const s = slack();
    const r = await run(["status", "@bob", "--set", "x"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/your own status/);
    expect(writes(s)).toEqual([]);
  });

  it("--emoji/--expires need --set", async () => {
    slack();
    expect((await run(["status", "--emoji", ":x:"])).stderr).toMatch(/go with --set/);
    expect((await run(["status", "--clear", "--set", "x"])).stderr).toMatch(/not both/);
  });

  it("set prints the team line", async () => {
    const s = slack();
    const r = await run(["status", "--set", "lunch", "--emoji", "taco", "--expires", "30"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(s.callsTo("users.profile.set")[0].params.profile)).toMatchObject({ status_text: "lunch", status_emoji: ":taco:" });
    expect(r.stdout).toContain('→ your status · team "Work" (workspace "work")');
  });
});

// ── Commands, help, serve ────────────────────────────────

describe("command dispatch (P2-11, P2-12)", () => {
  it("unknown command errors with a suggestion and doesn't serve", async () => {
    const r = await run(["sned", "general", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command 'sned'");
    expect(r.stderr).toContain("Did you mean send?");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("bare slacker in a terminal prints help", async () => {
    const r = await run([], { config: null, stdin: fakeStdin(undefined, true) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: slacker");
    expect(startServer).not.toHaveBeenCalled();
  });

  it("bare slacker on a pipe serves (MCP clients)", async () => {
    process.env.SLACKER_CONFIG = cfg.file;
    await run([], { config: null, stdin: fakeStdin() });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ configFile: cfg.file, readOnly: false, choice: expect.objectContaining({ source: "default" }) }));
  });

  it("slacker --workspace x --read-only serves even from a terminal", async () => {
    await run(["--workspace", "side", "--read-only"], { stdin: fakeStdin(undefined, true) });
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ workspace: "side", configFile: cfg.file, readOnly: true }));
  });

  it("a corrupt .slacker.json starts the server degraded instead of exiting", async () => {
    writeFileSync(join(cwd, ".slacker.json"), "{oops");
    const r = await run(["serve"]);
    expect(r.code).toBe(0);
    expect(startServer).toHaveBeenCalledWith(expect.objectContaining({ configFile: cfg.file, startupError: expect.stringMatching(/\.slacker\.json/) }));
  });

  it("global options work after the subcommand", async () => {
    const s = slack();
    expect((await run(["read", "general", "-w", "side"])).code).toBe(0);
    expect(s.callsTo("conversations.history")[0].headers.authorization).toBe("Bearer xoxc-side-token");
  });

  it("subcommand help shows the global options and examples mention quoting", async () => {
    const r = await run(["send", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Global Options:[\s\S]*--workspace/);
    const top = await run(["--help"]);
    expect(top.stdout).toContain("bare names only ever match channels");
    expect(top.stdout).toContain("--since 2h");
    expect(top.stdout).toContain("--dry-run");
  });
});

describe("read output (P2-18, P2-19)", () => {
  it("unread shows the conversation type", async () => {
    slack()
      .on("client.counts", { channels: [{ id: "C0GENERAL1", has_unreads: true, mention_count: 2, latest: "1700000000.000100" }], ims: [], mpims: [] })
      .on("conversations.info", { channel: GENERAL });
    const r = await run(["unread"]);
    expect(r.stdout).toMatch(/#general\s+channel\s+2 @/);
  });

  it("thread and channels print cursor hints", async () => {
    slack()
      .on("conversations.replies", { messages: [{ ts: "1700000000.123456", text: "parent", user: "U0MEMEME1" }], has_more: true, response_metadata: { next_cursor: "abc" } })
      .on("users.info", { user: { id: "U0MEMEME1", name: "me", profile: { display_name: "me" } } })
      .on("users.conversations", { channels: [GENERAL], response_metadata: { next_cursor: "next1" } });
    expect((await run(["thread", LINK, "--cursor", "c0"])).stdout).toContain("--cursor abc");
    expect((await run(["channels", "--cursor", "c0"])).stdout).toContain("More: --cursor next1");
  });
});

// ── whoami / auth ────────────────────────────────────────

describe("auth and identity (D3, D9, P2-5)", () => {
  it("whoami warns about aliases with fix steps", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    slack();
    const r = await run(["whoami"], { config: c.file });
    expect(r.stdout).toMatch(/Warning: Workspace "work" shares its Slack team with "copy" in config.json \(both sign in to "Work" \(T0WORK001\)\)/);
    expect(r.stdout).toMatch(/auth list → .*auth remove <name of the copy> → .*auth setup/);
    const j = JSON.parse((await run(["whoami", "--json"], { config: c.file })).stdout);
    expect(j).toMatchObject({ aliases: ["copy"], source: "default", readOnly: false, warning: expect.any(String) });
  });

  it("auth add reads SLACK_TOKEN/SLACK_COOKIE and never echoes them", async () => {
    const s = slack();
    process.env.SLACK_TOKEN = "xoxc-secret-token-123";
    process.env.SLACK_COOKIE = "xoxd-secret-cookie-456";
    const r = await run(["auth", "add", "fresh"]);
    expect(r.code).toBe(0);
    expect(s.callsTo("auth.test")[0].headers).toMatchObject({ authorization: "Bearer xoxc-secret-token-123", cookie: "d=xoxd-secret-cookie-456" });
    expect(readJson(cfg.file).workspaces.fresh).toMatchObject({ token: "xoxc-secret-token-123", cookie: "xoxd-secret-cookie-456" });
    for (const out of [r.stdout, r.stderr]) expect(out).not.toMatch(/secret/);
    expect(r.stdout).toContain('✓ Added "fresh"');
  });

  it("auth add reads two lines from piped stdin", async () => {
    slack();
    const r = await run(["auth", "add", "piped"], { stdin: fakeStdin("xoxc-piped-secret\r\nd=xoxd-piped-secret\r\n") });
    expect(r.code).toBe(0);
    expect(readJson(cfg.file).workspaces.piped).toMatchObject({ token: "xoxc-piped-secret", cookie: "xoxd-piped-secret" });
    expect(r.stdout + r.stderr).not.toMatch(/piped-secret/);
    expect((await run(["auth", "add", "short"], { stdin: fakeStdin("xoxc-only\n") })).stderr).toMatch(/two lines/);
  });

  it("auth add prompts on a TTY without echo", async () => {
    slack();
    const stdin = Object.assign(fakeStdin(undefined, true), { setRawMode: vi.fn() });
    const done = run(["auth", "add", "typed"], { stdin });
    setTimeout(() => stdin.write("xoxc-typed-secret\rxoxd-typed-secX\u007fret\r"), 10);
    const r = await done;
    expect(r.code).toBe(0);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(readJson(cfg.file).workspaces.typed).toMatchObject({ token: "xoxc-typed-secret", cookie: "xoxd-typed-secret" });
    expect(r.stderr).toContain("input hidden");
    expect(r.stdout + r.stderr).not.toMatch(/typed-sec/);
  });

  it("auth add refuses --token/--cookie flags", async () => {
    const s = slack();
    const r = await run(["auth", "add", "x", "--token", "xoxc-a", "--cookie", "xoxd-b"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/shell history/);
    expect(s.count()).toBe(0);
  });

  it("auth remove and rename", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    let r = await run(["auth", "rename", "copy", "spare"], { config: c.file });
    expect(r.stdout).toContain('✓ Renamed "copy" → "spare"');
    r = await run(["auth", "remove", "work"], { config: c.file });
    expect(r.stdout).toContain('✓ Removed "work"');
    expect(r.stdout).toContain("auth default");
    expect(readJson(c.file)).toMatchObject({ defaultWorkspace: null, workspaces: { spare: expect.any(Object) } });
    expect((await run(["auth", "remove", "nope"], { config: c.file })).stderr).toMatch(/not found/);
  });

  it("a corrupt .slacker.json doesn't block auth list; auth test names the file", async () => {
    slack();
    writeFileSync(join(cwd, ".slacker.json"), "null");
    const list = await run(["auth", "list"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toMatch(/work\s+ok/);
    // auth commands skip an invalid .slacker.json, with a warning naming it (F5).
    const test = await run(["auth", "test"]);
    expect(test.code).toBe(0);
    expect(test.stdout).toContain("✓ work");
    expect(test.stderr).toContain(join(cwd, ".slacker.json"));
    expect(test.stderr).toContain("Ignored for this command");
  });
});

// ── init (D7, P1-9) ──────────────────────────────────────

describe("init", () => {
  const projectFile = () => join(cwd, ".slacker.json");
  const mcpFile = () => join(cwd, ".mcp.json");

  it("writes .slacker.json and a slacker .mcp.json entry with --config", async () => {
    slack();
    const r = await run(["init", "work", "--mcp"]);
    expect(r.code).toBe(0);
    expect(readJson(projectFile())).toEqual({ workspace: "work" });
    expect(readJson(mcpFile())).toEqual({
      mcpServers: { slacker: { command: process.execPath, args: [entryPath(), "serve", "--workspace", "work", "--config", cfg.file] } },
    });
    expect(r.stdout).toContain("claude mcp add --scope local slacker --");
    expect(r.stdout).toContain("/mcp");
    expect(r.stdout).toMatch(/personal/);
  });

  it("--command, --read-only and --name", async () => {
    slack();
    expect((await run(["init", "--mcp", "--command", "slacker", "--read-only", "--name", "chat"])).code).toBe(0);
    expect(readJson(projectFile())).toEqual({ workspace: "work", readOnly: true });
    expect(readJson(mcpFile()).mcpServers.chat).toEqual({ command: "slacker", args: ["serve", "--workspace", "work", "--config", cfg.file, "--read-only"] });
  });

  it("merges into an existing .mcp.json and preserves readOnly and unknown keys on rerun", async () => {
    slack();
    writeFileSync(mcpFile(), JSON.stringify({ other: 1, mcpServers: { github: { command: "gh-mcp" } } }));
    writeFileSync(projectFile(), JSON.stringify({ workspace: "side", readOnly: true, note: "keep me" }));
    expect((await run(["init", "work", "--mcp", "--command", "slacker"])).code).toBe(0);
    expect(readJson(projectFile())).toEqual({ workspace: "work", readOnly: true, note: "keep me" });
    const mcp = readJson(mcpFile());
    expect(mcp.other).toBe(1);
    expect(mcp.mcpServers.github).toEqual({ command: "gh-mcp" });
    expect(mcp.mcpServers.slacker.args).toContain("--read-only");

    expect((await run(["init", "--no-read-only", "--mcp", "--command", "slacker"])).code).toBe(0);
    expect(readJson(projectFile())).toEqual({ workspace: "work", readOnly: false, note: "keep me" });
    expect(readJson(mcpFile()).mcpServers.slacker.args).not.toContain("--read-only");
  });

  it.each([["{not json"], ["null"], ["[]"], ['{"mcpServers": []}'], ['{"mcpServers": null}'], ['{"mcpServers": "x"}']])(
    "writes nothing when .mcp.json is %s",
    async (content) => {
      slack();
      writeFileSync(mcpFile(), content);
      const r = await run(["init", "work", "--mcp"]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(mcpFile());
      expect(existsSync(projectFile())).toBe(false);
      expect(readFileSync(mcpFile(), "utf-8")).toBe(content);
    }
  );

  it("refuses to replace a foreign entry unless --replace", async () => {
    slack();
    const foreign = { mcpServers: { slacker: { command: "npx", args: ["some-other-server"] } } };
    writeFileSync(mcpFile(), JSON.stringify(foreign));
    const r = await run(["init", "work", "--mcp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/isn't slacker.*--replace/);
    expect(existsSync(projectFile())).toBe(false);
    expect(readJson(mcpFile())).toEqual(foreign);
    expect((await run(["init", "work", "--mcp", "--allow-alias", "--command", "slacker"])).code).toBe(1); // wrong override
    const replaced = await run(["init", "work", "--mcp", "--replace", "--command", "slacker"]);
    expect(replaced.code).toBe(0);
    expect(replaced.stdout).toMatch(/--replace: overwrote the non-slacker server "slacker" in .*\(it ran npx\)/);
    expect(readJson(mcpFile()).mcpServers.slacker.command).toBe("slacker");
  });

  it("several workspaces get slacker-<ws> servers; needs --mcp; no --name", async () => {
    slack();
    expect((await run(["init", "work", "side"])).stderr).toMatch(/only make sense with --mcp/);
    expect((await run(["init", "work", "side", "--mcp", "--name", "x"])).stderr).toMatch(/--name works with a single workspace/);
    expect(existsSync(projectFile())).toBe(false);
    expect((await run(["init", "work", "side", "--mcp", "--command", "slacker"])).code).toBe(0);
    expect(readJson(projectFile()).workspace).toBe("work");
    expect(Object.keys(readJson(mcpFile()).mcpServers)).toEqual(["slacker-work", "slacker-side"]);
  });

  it("--mcp-only leaves .slacker.json alone; --json prints the result", async () => {
    slack();
    const r = await run(["--json", "init", "side", "--mcp-only", "--command", "slacker"]);
    expect(existsSync(projectFile())).toBe(false);
    expect(JSON.parse(r.stdout)).toMatchObject({ projectFile: null, workspace: "side", servers: [{ name: "slacker", workspace: "side" }] });
  });

  it("defaults to SLACKER_WORKSPACE, then the existing .slacker.json", async () => {
    slack();
    process.env.SLACKER_WORKSPACE = "side";
    await run(["init"]);
    expect(readJson(projectFile()).workspace).toBe("side");
    delete process.env.SLACKER_WORKSPACE;
    await run(["init"]);
    expect(readJson(projectFile()).workspace).toBe("side");
  });

  it("refuses a workspace that shares its team with another name unless --allow-alias", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    slack();
    const r = await run(["init", "copy", "--mcp"], { config: c.file });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Workspace "copy" shares its Slack team with "work"/);
    expect(r.stderr).toMatch(/auth remove <name of the copy>/);
    expect(r.stderr).toMatch(/pass --allow-alias/);
    expect(existsSync(projectFile())).toBe(false);
    expect(existsSync(mcpFile())).toBe(false);
    expect((await run(["init", "copy", "--replace"], { config: c.file })).code).toBe(1); // wrong override
    const allowed = await run(["init", "copy", "--allow-alias"], { config: c.file });
    expect(allowed.code).toBe(0);
    expect(allowed.stdout).toMatch(/Overridden — --allow-alias: pinned "copy" anyway/);
    expect(readJson(projectFile())).toEqual({ workspace: "copy" });
  });

  it("warns and continues when Slack can't be reached", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    cleanups.push(() => (globalThis.fetch = original));
    const r = await run(["init", "work"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Warning: Could not verify workspace "work"/);
    expect(readJson(projectFile())).toEqual({ workspace: "work" });
  });

  it("unknown workspace names fail before writing", async () => {
    const r = await run(["init", "nope", "--mcp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Workspace "nope" not found/);
    expect(existsSync(projectFile())).toBe(false);
    // The fallback names where it came from (F4).
    const flag = await run(["init", "-w", "nope2"]);
    expect(flag.stderr).toContain('Workspace "nope2" (from --workspace) not found');
  });
});

// ── Round 2: identity overrides, init flags, error codes, cosmetics ──

describe("alias writes (R1, R21)", () => {
  const aliasCommands = [
    ["send", "general", "hi"],
    ["send", "general", "hi", "--dry-run"],
    ["edit", LINK, "new"],
    ["delete", LINK, "--yes"],
    ["react", LINK, "eyes"],
    ["status", "--set", "lunch"],
    ["status", "--clear"],
  ];

  it("refuses every write (dry run too) when another name shares the team", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    const s = slack();
    for (const args of aliasCommands) {
      const r = await run(args, { config: c.file });
      expect(r.code, args.join(" ")).toBe(1);
      expect(r.stderr).toMatch(/shares credentials with "copy".*Refusing to write/);
      expect(r.stderr).toContain("--allow-alias");
    }
    expect(writes(s)).toEqual([]);
    const j = await run(["--json", "send", "general", "hi"], { config: c.file });
    expect(JSON.parse(j.stdout).error).toMatchObject({ code: "workspace_alias", hint: expect.stringMatching(/auth remove <copy>/) });
  });

  it("--allow-alias lets each write through", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    const s = slack();
    for (const args of aliasCommands) {
      const r = await run([...args, "--allow-alias"], { config: c.file });
      expect(r.code, `${args.join(" ")}: ${r.stderr}`).toBe(0);
    }
    expect(s.methods().filter((m) => WRITE_METHODS.includes(m))).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.delete",
      "reactions.add",
      "users.profile.set",
      "users.profile.set",
    ]);
  });

  it("--dry-run --allow-alias prints the destination and sends nothing", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    const s = slack();
    const r = await run(["send", "general", "x", "--dry-run", "--allow-alias"], { config: c.file });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Would send to #general · team "Work" (workspace "work")');
    expect(writes(s)).toEqual([]);
  });

  it("an entry without a teamId can't write unless --allow-alias (team_unverified)", async () => {
    const c = tempConfig({ work: { teamId: "" } }, "work");
    const s = slack();
    const j = await run(["--json", "send", "general", "hi"], { config: c.file });
    expect(JSON.parse(j.stdout).error.code).toBe("team_unverified");
    expect((await run(["send", "general", "hi", "--allow-alias"], { config: c.file })).code).toBe(0);
    expect(posted(s)).toEqual(["hi"]);
    const who = await run(["whoami"], { config: c.file });
    expect(who.stdout).toMatch(/Warning: Workspace "work" has no teamId in config.json/);
  });

  it("--allow-alias never bypasses a team mismatch", async () => {
    const c = tempConfig({ work: { teamId: "T0OTHER01" } }, "work");
    const s = slack();
    const r = await run(["--json", "send", "general", "hi", "--allow-alias"], { config: c.file });
    expect(JSON.parse(r.stdout).error.code).toBe("team_mismatch");
    expect(writes(s)).toEqual([]);
  });

  it("status --allow-alias without --set/--clear is an error", async () => {
    slack();
    const r = await run(["--json", "status", "--allow-alias"]);
    expect(JSON.parse(r.stdout).error.code).toBe("invalid_argument");
  });
});

describe("whoami / auth test identity warnings (R20)", () => {
  it("warn when the credentials sign in to another team than config.json says", async () => {
    const c = tempConfig({ work: { teamId: "T0OTHER01" } }, "work");
    slack();
    for (const cmd of [["whoami"], ["auth", "test"]]) {
      const r = await run(cmd, { config: c.file });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Warning: config.json says workspace "work" is team T0OTHER01, but its credentials sign in to "Work" \(T0WORK001\)/);
    }
    const j = JSON.parse((await run(["auth", "test", "--json"], { config: c.file })).stdout);
    expect(j.warning).toMatch(/is team T0OTHER01/);
  });

  it("no warning for a clean workspace", async () => {
    slack();
    const j = JSON.parse((await run(["whoami", "--json"])).stdout);
    expect(j).not.toHaveProperty("warning");
    expect((await run(["auth", "test"])).stdout).not.toMatch(/Warning/);
  });
});

describe("errors and hints (R17, R23)", () => {
  it("--json errors carry SlackerError codes", async () => {
    slack();
    expect(JSON.parse((await run(["--json", "read", "nosuch"])).stdout).error.code).toBe("channel_not_found");
    expect(JSON.parse((await run(["--json", "status", "--clear", "--set", "x"])).stdout).error.code).toBe("invalid_argument");
    expect(JSON.parse((await run(["--json", "send", "general", "a", "b"])).stdout).error.code).toBe("unquoted_text");
  });

  it("human errors print only the message (no repeated hint)", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    slack();
    const r = await run(["send", "general", "hi"], { config: c.file });
    // The message, then one line saying how to run slacker (not on PATH in tests; -c in use) — F1.
    const lines = r.stderr.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^slacker: Workspace "work" shares credentials/);
    expect(lines[0]).toContain("slacker auth list → slacker auth remove <copy> → slacker auth setup");
    expect(lines[0]).not.toContain(entryPath());
    expect(lines[1]).toBe(`(run slacker as: "${process.execPath}" "${entryPath()}" -c "${c.file}")`);
  });

  it("hints name a non-default config with -c (flag or SLACKER_CONFIG)", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    slack();
    const flag = await run(["send", "general", "hi"], { config: c.file });
    expect(flag.stderr).toContain(`-c "${c.file}")`);
    process.env.SLACKER_CONFIG = c.file;
    const env = await run(["send", "general", "hi"], { config: null });
    expect(env.stderr).toContain(`-c "${c.file}")`);
    expect(env.stderr.split("(run slacker as:")).toHaveLength(2);
  });

  it('text like "-w side" that commander takes for an option gets the -- hint', async () => {
    const s = slack();
    const r = await run(["send", "general", "-w side"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/missing required argument/);
    expect(r.stderr).toContain("Put -- before message text");
    expect(writes(s)).toEqual([]);
  });
});

describe("output cosmetics (R23)", () => {
  it("search with no matches prints no page counter; channels pluralize", async () => {
    const s = slack();
    s.on("search.messages", { messages: { matches: [], total: 0, paging: { page: 1, pages: 0 } } });
    const r = await run(["search", "nothing"]);
    expect(r.stdout).toContain("0 matches");
    expect(r.stdout).not.toContain("page");
    expect((await run(["channels"])).stdout).toMatch(/^1 channel$/m);
  });

  it("unread marks archived conversations", async () => {
    slack()
      .on("client.counts", { channels: [{ id: "C0GENERAL1", has_unreads: true, mention_count: 0, latest: "1700000000.000100" }] })
      .on("conversations.info", { channel: { ...GENERAL, is_archived: true } });
    expect((await run(["unread"])).stdout).toMatch(/#general.*archived/);
  });

  it("a dry run to a person prints the person and opens no DM", async () => {
    const s = slack().on("users.info", { user: makeUser("U0AAAAAA1", "ann", "Ann Example") });
    const r = await run(["send", "U0AAAAAA1", "hi", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Would send to @ann/);
    expect(s.count("conversations.open")).toBe(0);
    const j = JSON.parse((await run(["--json", "send", "U0AAAAAA1", "hi", "--dry-run"])).stdout);
    expect(j.destination).toMatchObject({ id: null, type: "dm", userId: "U0AAAAAA1" });
  });

  it("auth add prints the default-workspace note", async () => {
    const c = tempConfig({}, null);
    slack();
    process.env.SLACK_TOKEN = "xoxc-secret-token-123";
    process.env.SLACK_COOKIE = "xoxd-secret-cookie-456";
    const r = await run(["auth", "add", "fresh"], { config: c.file });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/"fresh" is now the default workspace/);
  });
});

describe("init (R18, R19)", () => {
  const projectFile = () => join(cwd, ".slacker.json");
  const mcpFile = () => join(cwd, ".mcp.json");

  /** A fake node executable that prints `version` for -v. */
  function fakeNode(version: string): string {
    const dir = mkdtempSync(join(tmpdir(), "slacker-node-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "node");
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  it("--node runs this install's entry with that node", async () => {
    slack();
    const node = fakeNode("v24.1.0");
    const r = await run(["init", "work", "--mcp-only", "--node", node]);
    expect(r.code, r.stderr).toBe(0);
    expect(readJson(mcpFile()).mcpServers.slacker).toEqual({ command: node, args: [entryPath(), "serve", "--workspace", "work", "--config", cfg.file] });
    expect(r.stdout).not.toMatch(/Warning/);
    const old = await run(["init", "work", "--mcp-only", "--node", fakeNode("v20.5.0")]);
    expect(old.stdout).toMatch(/is Node v20\.5\.0, but slacker needs Node 22\.12/);
    expect((await run(["init", "--mcp", "--node", node, "--command", "slacker"])).stderr).toMatch(/not both/);
    expect((await run(["init", "--mcp", "--node", join(cwd, "nope")])).stderr).toMatch(/no such file/);
  });

  it("--command keeps the entry path unless the command is slacker", async () => {
    slack();
    await run(["init", "work", "--mcp-only", "--command", "/opt/node/bin/node"]);
    expect(readJson(mcpFile()).mcpServers.slacker.args.slice(0, 2)).toEqual([entryPath(), "serve"]);
    await run(["init", "work", "--mcp-only", "--command", "/usr/local/bin/slacker"]);
    expect(readJson(mcpFile()).mcpServers.slacker.args[0]).toBe("serve");
  });

  it("under nvm, suggests a stable node ≥22.12 via --node", async () => {
    slack();
    const nvm = "/Users/me/.nvm/versions/node/v24.1.0/bin/node";
    const stable = fakeNode("v24.2.0");
    const io = { execPath: nvm, nodeCandidates: [join(cwd, "missing-node"), fakeNode("v20.1.0"), stable] };
    const r = await run(["init", "work", "--mcp"], { io });
    expect(r.code).toBe(0);
    expect(readJson(mcpFile()).mcpServers.slacker.command).toBe(nvm);
    expect(r.stdout).toMatch(/pinned to one nvm Node version/);
    expect(r.stdout).toContain(`--node ${stable} (v24.2.0)`);
    expect(r.stdout).toMatch(/npm link under nvm is pinned the same way/);

    const none = await run(["init", "work", "--mcp"], { io: { execPath: nvm, nodeCandidates: [fakeNode("v22.11.0")] } });
    expect(none.stdout).toMatch(/Install Node 22\.12\+ outside nvm/);
  });

  it("refuses an existing .slacker.json the schema rejects, naming it; --replace overwrites", async () => {
    slack();
    const bad = JSON.stringify({ workspace: "work", readOnly: "yes" });
    writeFileSync(projectFile(), bad);
    const r = await run(["init", "work", "--mcp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Invalid ${projectFile()}: "readOnly" must be true or false`);
    expect(r.stderr).toMatch(/--replace/);
    expect(readFileSync(projectFile(), "utf-8")).toBe(bad);
    expect(existsSync(mcpFile())).toBe(false);
    const replaced = await run(["init", "work", "--replace"]);
    expect(replaced.code).toBe(0);
    expect(replaced.stdout).toMatch(/--replace: overwrote .*\.slacker\.json, which was invalid/);
    expect(readJson(projectFile())).toEqual({ workspace: "work" });
  });

  it("writes both files atomically (the file is replaced, not rewritten in place)", async () => {
    slack();
    writeFileSync(projectFile(), JSON.stringify({ workspace: "side" }));
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: {} }));
    const before = [statSync(projectFile()).ino, statSync(mcpFile()).ino];
    expect((await run(["init", "work", "--mcp", "--command", "slacker"])).code).toBe(0);
    expect([statSync(projectFile()).ino, statSync(mcpFile()).ino]).not.toContain(before[0]);
    expect(statSync(mcpFile()).ino).not.toBe(before[1]);
    expect(lstatSync(projectFile()).isFile()).toBe(true);
  });

  it("warns about an older plain slacker entry when moving to one server per workspace; --replace removes it", async () => {
    slack();
    const plain = { command: "slacker", args: ["serve", "--workspace", "work"] };
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { slacker: plain } }));
    const r = await run(["init", "work", "side", "--mcp", "--command", "slacker"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/older "slacker" server for workspace "work".*--replace/);
    expect(Object.keys(readJson(mcpFile()).mcpServers)).toEqual(["slacker", "slacker-work", "slacker-side"]);
    const replaced = await run(["init", "work", "side", "--mcp", "--command", "slacker", "--replace"]);
    expect(replaced.stdout).toContain('✓ Removed "slacker" from .mcp.json');
    expect(Object.keys(readJson(mcpFile()).mcpServers)).toEqual(["slacker-work", "slacker-side"]);
  });

  it("recognizes slacker entries by serve + --workspace + a slacker command or entry", async () => {
    slack();
    for (const entry of [
      { command: "npx", args: ["-y", "@manasnilorout/slacker", "serve", "--workspace", "side"] },
      { command: "/usr/bin/node", args: ["/elsewhere/slacker/dist/index.js", "serve", "--workspace", "side"] },
    ]) {
      writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { slacker: entry } }));
      expect((await run(["init", "work", "--mcp-only", "--command", "slacker"])).code).toBe(0);
    }
    // "slacker" in the name alone isn't enough.
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { slacker: { command: "slacker-proxy", args: ["serve"] } } }));
    expect((await run(["init", "work", "--mcp-only"])).stderr).toMatch(/isn't slacker/);
  });

  it("hidden --force means both and prints exactly what it overrode", async () => {
    const c = tempConfig({ work: {}, copy: {} }, "work");
    slack();
    writeFileSync(mcpFile(), JSON.stringify({ mcpServers: { slacker: { command: "npx", args: ["other"] } } }));
    const r = await run(["init", "copy", "--mcp", "--force", "--command", "slacker"], { config: c.file });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/--force: pinned "copy" anyway/);
    expect(r.stdout).toMatch(/--force: overwrote the non-slacker server "slacker"/);
    const j = JSON.parse((await run(["--json", "init", "copy", "--force"], { config: c.file })).stdout);
    expect(j.overridden).toEqual([expect.stringMatching(/^--force: pinned "copy" anyway/)]);
    expect((await run(["init", "--help"])).stdout).not.toContain("--force");
    const nothing = await run(["init", "work", "--force"]);
    expect(nothing.stdout).toContain("--force: nothing needed overriding.");
  });

  it("separate refusals: team mismatch and missing teamId", async () => {
    slack();
    const mismatch = tempConfig({ work: { teamId: "T0OTHER01" } }, "work");
    const r1 = JSON.parse((await run(["--json", "init", "work"], { config: mismatch.file })).stdout).error;
    expect(r1.code).toBe("team_mismatch");
    expect(r1.message).toMatch(/is team T0OTHER01.*auth remove work/);
    const unverified = tempConfig({ work: { teamId: "" } }, "work");
    const r2 = JSON.parse((await run(["--json", "init", "work"], { config: unverified.file })).stdout).error;
    expect(r2.code).toBe("team_unverified");
    expect(r2.message).toMatch(/no teamId.*auth setup/);
    expect(existsSync(projectFile())).toBe(false);
  });

  it("rejected credentials: loud error with the refresh hint, but init continues", async () => {
    slack().fail("auth.test", "invalid_auth");
    const r = await run(["init", "work"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✗ Slack rejected the credentials for workspace "work".*auth refresh/);
    expect(readJson(projectFile())).toEqual({ workspace: "work" });
  });
});

// ── Round 3 ──────────────────────────────────────────────

describe("an invalid .slacker.json (F5)", () => {
  const corrupt = () => writeFileSync(join(cwd, ".slacker.json"), '{"workspace": 1}');

  it("read commands with -w (or SLACKER_WORKSPACE) skip it with a warning", async () => {
    slack();
    corrupt();
    const r = await run(["read", "general", "-w", "work"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain(`Warning: Invalid ${join(cwd, ".slacker.json")}`);
    expect(r.stderr).toContain("Ignored for this command; write commands refuse to run until it's fixed.");
    process.env.SLACKER_WORKSPACE = "work";
    expect((await run(["whoami"])).code).toBe(0);
  });

  it("auth test -w works; read commands without a named workspace still fail", async () => {
    slack();
    corrupt();
    const t = await run(["auth", "test", "-w", "side"]);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain("✓ side");
    const r = await run(["read", "general"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`Invalid ${join(cwd, ".slacker.json")}`);
  });

  it("write commands fail closed even with -w (it may say read-only)", async () => {
    const s = slack();
    corrupt();
    for (const args of [
      ["send", "general", "hi", "-w", "work"],
      ["send", "general", "hi", "-w", "work", "--dry-run"],
      ["react", LINK, "eyes", "-w", "work"],
      ["status", "--clear", "-w", "work"],
    ]) {
      const r = await run(["--json", ...args]);
      expect(r.code).toBe(1);
      expect(JSON.parse(r.stdout).error.code).toBe("invalid_project_file");
    }
    expect(writes(s)).toEqual([]);
  });
});

describe("workspace errors name their source (F4)", () => {
  it("--workspace, SLACKER_WORKSPACE, .slacker.json and defaultWorkspace", async () => {
    slack();
    expect((await run(["read", "general", "-w", "nope"])).stderr).toContain('Workspace "nope" (from --workspace) not found');
    process.env.SLACKER_WORKSPACE = "nope";
    expect((await run(["read", "general"])).stderr).toContain('Workspace "nope" (from SLACKER_WORKSPACE) not found');
    delete process.env.SLACKER_WORKSPACE;
    writeFileSync(join(cwd, ".slacker.json"), '{"workspace": "nope"}');
    expect((await run(["read", "general"])).stderr).toContain(`Workspace "nope" (from .slacker.json at ${join(cwd, ".slacker.json")}) not found`);
    const dflt = tempConfig({ work: {} }, "gone");
    const emptyCwd = mkdtempSync(join(tmpdir(), "slacker-cli-cwd-"));
    cleanups.push(() => rmSync(emptyCwd, { recursive: true, force: true }));
    const r = await run(["--json", "read", "general"], { config: dflt.file, cwd: emptyCwd });
    expect(JSON.parse(r.stdout).error).toMatchObject({ code: "workspace_not_found", message: expect.stringContaining('Workspace "gone" (defaultWorkspace in config.json) not found') });
  });
});

describe("config/auth error codes in --json (F7)", () => {
  const err = async (args: string[], o: Parameters<typeof run>[1] = {}) => JSON.parse((await run(["--json", ...args], o)).stdout).error;

  it("codes for config problems", async () => {
    slack();
    expect((await err(["read", "general", "-w", "nope"])).code).toBe("workspace_not_found");
    const empty = tempConfig({}, null);
    expect(await err(["read", "general"], { config: empty.file })).toMatchObject({ code: "no_workspaces", hint: expect.stringMatching(/^slacker auth setup\n\(run slacker as: .+\)$/) });
    const noDefault = tempConfig({ work: {} }, null);
    expect(await err(["read", "general"], { config: noDefault.file })).toMatchObject({ code: "no_default_workspace", hint: expect.stringMatching(/^slacker auth default <name>\n/) });
    const broken = tempConfig();
    writeFileSync(broken.file, "{not json");
    expect((await err(["read", "general"], { config: broken.file })).code).toBe("invalid_config");
    writeFileSync(broken.file, '{"workspaces": []}');
    expect((await err(["auth", "list"], { config: broken.file })).code).toBe("invalid_config");
  });

  it("codes for auth mutations", async () => {
    slack();
    expect((await err(["auth", "rename", "work", "side"])).code).toBe("workspace_exists");
    expect((await err(["auth", "rename", "work", "bad name"])).code).toBe("invalid_workspace_name");
    expect((await err(["auth", "remove", "nope"])).code).toBe("workspace_not_found");
  });

  it("http_error for a non-JSON HTTP response", async () => {
    installSlackStub().on("auth.test", () => new Response("<html>bad request</html>", { status: 400 }));
    const e = await err(["auth", "test"]);
    expect(e.code).toBe("http_error");
    expect(e.message).toMatch(/HTTP 400 with a non-JSON response/);
  });

  it("Slack API hints are their own capitalized field", async () => {
    slack().fail("auth.test", "invalid_auth");
    const e = await err(["auth", "test"]);
    expect(e.message).toBe("Slack API error (auth.test): invalid_auth");
    expect(e.hint).toMatch(/^Your session credentials look stale\. Run: slacker auth refresh/);
  });
});

describe("delete checks before asking (F8)", () => {
  const tty = (answer: string) => fakeStdin(answer, true);

  it("shows the resolved destination in the prompt, then deletes on yes", async () => {
    const s = slack();
    const r = await run(["delete", LINK], { stdin: tty("y\n") });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('Delete message 1700000000.123456 in #general · team "Work" (workspace "work")? [y/N]');
    expect(s.count("chat.delete")).toBe(1);
  });

  it("no prompt for a bad ts or an aliased workspace", async () => {
    const s = slack();
    const bad = await run(["--json", "delete", "general", "--ts", "nope"], { stdin: tty("y\n") });
    expect(JSON.parse(bad.stdout).error.code).toBe("invalid_ts");
    expect(bad.stderr).not.toContain("[y/N]");
    expect(s.count()).toBe(0); // pure validation: no network either
    const c = tempConfig({ work: {}, copy: {} }, "work");
    const alias = await run(["--json", "delete", LINK], { stdin: tty("y\n"), config: c.file });
    expect(JSON.parse(alias.stdout).error.code).toBe("workspace_alias");
    expect(alias.stderr).not.toContain("[y/N]");
    expect(s.count("chat.delete")).toBe(0);
  });

  it("answering no cancels", async () => {
    const s = slack();
    const r = await run(["--json", "delete", LINK], { stdin: tty("n\n") });
    expect(JSON.parse(r.stdout).error.code).toBe("cancelled");
    expect(s.count("chat.delete")).toBe(0);
  });
});

describe("init flag checks come first (F10)", () => {
  it("--node/--command conflicts and a missing --node fail before the live check", async () => {
    const s = slack();
    const both = await run(["--json", "init", "work", "--mcp", "--node", process.execPath, "--command", "slacker"]);
    expect(JSON.parse(both.stdout).error.message).toBe("Use --node or --command, not both.");
    const missing = await run(["--json", "init", "work", "--mcp", "--node", "/no/such/node"]);
    expect(JSON.parse(missing.stdout).error.message).toMatch(/--node \/no\/such\/node: no such file/);
    expect(s.count("auth.test")).toBe(0);
    expect(existsSync(join(cwd, ".slacker.json"))).toBe(false);
  });

  it("warns that --node/--command do nothing without --mcp", async () => {
    slack();
    const r = await run(["init", "work", "--command", "slacker"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Warning: --command only changes the .mcp.json entry, so it was ignored without --mcp or --mcp-only.");
    expect(existsSync(join(cwd, ".mcp.json"))).toBe(false);
  });
});

describe("init --mcp-only with an invalid .slacker.json (F9)", () => {
  it("leaves it untouched and says the server will start degraded (no false 'overwrote')", async () => {
    slack();
    const file = join(cwd, ".slacker.json");
    writeFileSync(file, "{oops");
    const r = JSON.parse((await run(["--json", "init", "work", "--mcp-only", "--replace", "--command", "slacker"])).stdout);
    expect(readFileSync(file, "utf-8")).toBe("{oops");
    expect(r.overridden).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/left untouched \(--mcp-only\).*starts degraded/);
    expect(readJson(join(cwd, ".mcp.json")).mcpServers.slacker.args).toEqual(["serve", "--workspace", "work", "--config", cfg.file]);
  });
});
