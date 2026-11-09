import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

vi.mock("../src/server.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/server.js")>();
  return { ...real, startServer: vi.fn(async () => {}) };
});

import { CliIO, main } from "../src/cli.js";
import { setActiveConfig } from "../src/command.js";
import { createServer, ServerOptions, startServer } from "../src/server.js";
import {
  addPersona,
  listPersonas,
  loadWebhooks,
  normalizeChannel,
  normalizeIcon,
  normalizeUsername,
  parseWebhookUrl,
  redactWebhookUrl,
  removePersona,
  resolvePersona,
  sendWebhook,
  setDefaultPersona,
} from "../src/webhook.js";
import { writeTempConfig } from "./helpers/slackStub.js";

// Fake webhooks (never a real one): the team of the first matches the "work" workspace in temp configs.
const SECRET = "fakeSecretTOKEN123";
const URL_WORK = `https://hooks.slack.com/services/T0WORK001/B0HOOK0001/${SECRET}`;
const URL_OTHER = "https://hooks.slack.com/services/T0OTHER01/B0HOOK0002/otherFakeSecret9";

const ENV_KEYS = [
  "SLACKER_WEBHOOK_URL",
  "SLACKER_WEBHOOK_USERNAME",
  "SLACKER_WEBHOOK_ICON",
  "SLACKER_WEBHOOK_CHANNEL",
  "SLACKER_WEBHOOK_PERSONA",
  "SLACKER_WORKSPACE",
  "SLACKER_READ_ONLY",
];
const savedEnv = { ...process.env };
const cleanups: Array<() => unknown> = [];
let dir: string;
let file: string;
let cfg: ReturnType<typeof writeTempConfig>;

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), "slacker-webhook-"));
  file = join(dir, "slacker", "webhooks.json");
  process.env.SLACKER_WEBHOOKS_FILE = file;
  cfg = writeTempConfig({ work: {} }, "work");
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => cfg.cleanup());
});

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setActiveConfig(undefined);
  process.env = { ...savedEnv };
});

interface Posted {
  url: string;
  body: Record<string, string>;
}

/** Replace fetch: every webhook post is recorded and answered with `status` / `body`. */
function stubFetch(status = 200, body = "ok"): Posted[] {
  const posts: Posted[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(body, { status });
    })
  );
  return posts;
}

// ── Validation ───────────────────────────────────────────

describe("webhook URL, icon, channel and bot name", () => {
  it("accepts Slack webhook URLs and reports their team", () => {
    expect(parseWebhookUrl(URL_WORK)).toEqual({ url: URL_WORK, teamId: "T0WORK001", hookId: "B0HOOK0001" });
    expect(parseWebhookUrl(`  ${URL_WORK}\n`).url).toBe(URL_WORK);
    expect(parseWebhookUrl("https://hooks.slack-gov.com/services/T1/B2/x").teamId).toBe("T1");
  });

  it.each([
    ["http://hooks.slack.com/services/T1/B2/x", "https://"],
    ["https://evil.example.com/services/T1/B2/x", "host"],
    ["https://hooks.slack.com.evil.com/services/T1/B2/x", "host"],
    ["https://hooks.slack.com/services/T1/B2/x?redirect=1", "?"],
    ["https://hooks.slack.com/triggers/T1/123/x", "path"],
    ["not a url", "not a URL"],
  ])("rejects %s without echoing it", (url, why) => {
    expect(() => parseWebhookUrl(url)).toThrow(why);
    try {
      parseWebhookUrl(url);
    } catch (e) {
      expect((e as Error).message).not.toContain(url);
    }
  });

  it("redacts the secret part", () => {
    expect(redactWebhookUrl(URL_WORK)).toBe("https://hooks.slack.com/services/T0WORK001/B0HOOK0001/••••");
    expect(redactWebhookUrl(URL_WORK)).not.toContain(SECRET);
  });

  it("normalizes icons, channels and bot names", () => {
    expect(normalizeIcon("rocket")).toBe(":rocket:");
    expect(normalizeIcon(":Robot_Face:")).toBe(":robot_face:");
    expect(normalizeIcon(":wave::skin-tone-3:")).toBe(":wave::skin-tone-3:");
    expect(normalizeIcon("https://example.com/logo.png")).toBe("https://example.com/logo.png");
    expect(() => normalizeIcon("not an emoji")).toThrow(/emoji name/);
    expect(normalizeChannel("deploys")).toBe("#deploys");
    expect(normalizeChannel("#deploys")).toBe("#deploys");
    expect(normalizeChannel("@alice")).toBe("@alice");
    expect(normalizeChannel("C0123456789")).toBe("C0123456789");
    expect(() => normalizeChannel("#")).toThrow(/Invalid channel/);
    expect(() => normalizeChannel("two words")).toThrow(/Invalid channel/);
    expect(normalizeUsername("  Deploy Bot ")).toBe("Deploy Bot");
    expect(() => normalizeUsername("line\nbreak")).toThrow(/control characters/);
    expect(() => normalizeUsername("x".repeat(81))).toThrow(/at most 80/);
    expect(() => normalizeUsername("evil\u202ename")).toThrow(/bidi/);
    expect(normalizeIcon("+1")).toBe(":+1:");
    expect(normalizeIcon(":-1:")).toBe(":-1:");
    expect(() => normalizeIcon("🚀")).toThrow(/not the emoji character/);
    expect(() => normalizeChannel("#a\u001b[2Jb")).toThrow(/Invalid channel/);
    expect(() => normalizeChannel("<#C0123456789>")).toThrow(/Invalid channel/);
    expect(() => normalizeChannel("@here")).toThrow(/is a mention, not a destination/);
    expect(() => normalizeIcon(":-:")).toThrow(/Invalid icon/);
    expect(() => normalizeIcon("_")).toThrow(/Invalid icon/);
    expect(normalizeIcon("+1::skin-tone-2")).toBe(":+1::skin-tone-2:");
    expect(normalizeChannel("U0123456789")).toBe("U0123456789");
    expect(parseWebhookUrl(`${URL_WORK}#`).url).toBe(URL_WORK);
  });
});

// ── The store ────────────────────────────────────────────

describe("persona store", () => {
  it("adds a persona as 0600, makes the first one the default and detects the workspace from config.json", () => {
    const r = addPersona({ name: "deploy-bot", url: URL_WORK, username: "Deploy Bot", icon: "rocket", channel: "deploys" }, { configFile: cfg.file });
    expect(r).toMatchObject({
      action: "added",
      username: "Deploy Bot",
      icon: ":rocket:",
      channel: "#deploys",
      workspace: "work",
      workspaceDetected: true,
      teamId: "T0WORK001",
      isDefault: true,
      isWorkspaceDefault: true,
    });
    expect(r.webhook).not.toContain(SECRET);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "slacker")).mode & 0o777).toBe(0o700);
    const store = loadWebhooks();
    expect(store.defaultPersona).toBe("deploy-bot");
    expect(store.workspaceDefaults).toEqual({ work: "deploy-bot" });
    expect(store.personas["deploy-bot"].url).toBe(URL_WORK);
  });

  it("updates only the fields given, keeps the URL when none is passed, and clears a field with an empty string", () => {
    addPersona({ name: "bot", url: URL_WORK, username: "Bot", icon: "robot_face", channel: "general" });
    const r = addPersona({ name: "bot", icon: "eyes", channel: "" });
    expect(r).toMatchObject({ action: "updated", username: "Bot", icon: ":eyes:", channel: null });
    expect(loadWebhooks().personas.bot.url).toBe(URL_WORK);
  });

  it("refuses a new persona without a URL, a reserved name, and a webhook from another team than -w", () => {
    expect(() => addPersona({ name: "new" })).toThrow(/needs a webhook URL/);
    expect(() => addPersona({ name: "env", url: URL_WORK })).toThrow(/reserved/);
    expect(() => addPersona({ name: "x", url: URL_OTHER, workspace: "work" }, { configFile: cfg.file })).toThrow(/team T0OTHER01, but workspace "work" in config.json is team T0WORK001/);
    expect(addPersona({ name: "x", url: URL_OTHER, workspace: "work", force: true }, { configFile: cfg.file }).workspace).toBe("work");
  });

  it("sets and unsets global and per-workspace defaults; remove clears them", () => {
    addPersona({ name: "a", url: URL_WORK });
    addPersona({ name: "b", url: URL_OTHER, workspace: "other" });
    expect(loadWebhooks()).toMatchObject({ defaultPersona: "a", workspaceDefaults: { other: "b" } });
    expect(setDefaultPersona("b")).toEqual({ persona: "b", workspace: null, previous: "a" });
    expect(setDefaultPersona("a", "other")).toEqual({ persona: "a", workspace: "other", previous: "b" });
    expect(setDefaultPersona(null, "other")).toEqual({ persona: null, workspace: "other", previous: "a" });
    expect(() => setDefaultPersona("nope")).toThrow(/No webhook persona "nope"/);
    setDefaultPersona("b", "other");
    expect(removePersona("b")).toMatchObject({ removed: "b", defaultPersona: null, clearedWorkspaceDefaults: ["other"] });
  });

  it("re-checks the team when an update changes the URL, and keeps the old label's default honest", () => {
    addPersona({ name: "x", url: URL_WORK }, { configFile: cfg.file }); // labelled "work" (detected)
    expect(() => addPersona({ name: "x", url: URL_OTHER }, { configFile: cfg.file })).toThrow(/team T0OTHER01, but workspace "work" in config.json is team T0WORK001/);
    expect(loadWebhooks().personas.x.url).toBe(URL_WORK);
    const r = addPersona({ name: "x", url: URL_OTHER, workspace: "other" }, { configFile: cfg.file });
    expect(r).toMatchObject({ urlChanged: true, workspace: "other", becameWorkspaceDefault: true });
    expect(loadWebhooks().workspaceDefaults).toEqual({ other: "x" }); // no longer "work"'s default
  });

  it("never brings back a default you removed, or deletes one you set, when updating", () => {
    addPersona({ name: "a", url: URL_WORK }, { configFile: cfg.file });
    setDefaultPersona(null);
    expect(addPersona({ name: "a", icon: "eyes" }, { configFile: cfg.file })).toMatchObject({ isDefault: false, becameDefault: false });
    addPersona({ name: "b", url: URL_OTHER });
    setDefaultPersona("b", "side");
    addPersona({ name: "b", icon: "fire" });
    expect(loadWebhooks().workspaceDefaults.side).toBe("b");
    setDefaultPersona(null, "work");
    addPersona({ name: "a", workspace: "" }, { configFile: cfg.file }); // remove the label
    expect(addPersona({ name: "a", icon: "tada" }, { configFile: cfg.file })).toMatchObject({ workspace: null, workspaceDetected: false });
    expect(loadWebhooks().workspaceDefaults.work).toBeUndefined();
  });

  it("doesn't re-ask about a --force'd team mismatch on every update, or make it the workspace's default", () => {
    const r = addPersona({ name: "f", url: URL_OTHER, workspace: "work", force: true }, { configFile: cfg.file });
    expect(r).toMatchObject({ workspace: "work", becameWorkspaceDefault: false });
    expect(addPersona({ name: "f", icon: "eyes" }, { configFile: cfg.file }).icon).toBe(":eyes:");
    expect(() => addPersona({ name: "f", url: URL_OTHER.replace("B0HOOK0002", "B0HOOK0003") }, { configFile: cfg.file })).toThrow(/team_mismatch|in config.json is team/);
    expect(loadWebhooks().workspaceDefaults.work).toBeUndefined();
  });

  it("refuses a workspace default on another team, and bad workspace names", () => {
    addPersona({ name: "other", url: URL_OTHER });
    expect(() => setDefaultPersona("other", "work", { configFile: cfg.file })).toThrow(/team_mismatch|team T0OTHER01, but workspace "work"/);
    expect(() => setDefaultPersona("other", "__proto__")).toThrow(/Invalid workspace name/);
    expect(() => addPersona({ name: "y", url: URL_WORK, workspace: "a b" })).toThrow(/Invalid workspace name/);
  });

  it("refuses a webhook URL where a name, icon, channel or bot name belongs, without echoing it", () => {
    addPersona({ name: "a", url: URL_WORK });
    for (const fn of [
      () => removePersona(URL_OTHER),
      () => resolvePersona({ persona: URL_OTHER }),
      () => addPersona({ name: "b", url: URL_WORK, icon: URL_OTHER }),
      () => addPersona({ name: "b", url: URL_WORK, channel: URL_OTHER }),
      () => addPersona({ name: "b", url: URL_WORK, username: URL_OTHER }),
      () => setDefaultPersona("a", URL_OTHER),
    ]) {
      let err: Error | undefined;
      try {
        fn();
      } catch (e) {
        err = e as Error;
      }
      expect(err?.message).toMatch(/looks like a webhook URL/);
      expect(err?.message).not.toContain("otherFakeSecret9");
    }
  });

  it("doesn't quote the file's text (maybe a URL) when webhooks.json isn't valid JSON", () => {
    addPersona({ name: "a", url: URL_WORK });
    writeFileSync(file, `{"personas":{"a":{"url":${URL_WORK}}}}`, { mode: 0o600 }); // unquoted: V8 would quote the text
    expect(() => loadWebhooks()).toThrow(/not valid JSON/);
    try {
      loadWebhooks();
    } catch (e) {
      expect((e as Error).message).not.toContain(SECRET.slice(-6));
    }
  });

  it("refuses a webhook file someone else could change", () => {
    addPersona({ name: "a", url: URL_WORK });
    chmodSync(file, 0o666);
    expect(() => loadWebhooks()).toThrow(/someone else could change where your posts go/);
  });

  it("reports a corrupt file", () => {
    addPersona({ name: "a", url: URL_WORK });
    writeFileSync(file, JSON.stringify({ personas: { a: { url: "https://example.com/x" } } }), { mode: 0o600 });
    expect(() => loadWebhooks()).toThrow(/persona "a" has an invalid "url"/);
  });

  it("lists personas without their secrets, plus the env persona", () => {
    addPersona({ name: "a", url: URL_WORK, username: "A" });
    process.env.SLACKER_WEBHOOK_URL = URL_OTHER;
    process.env.SLACKER_WEBHOOK_ICON = "ghost";
    const list = listPersonas();
    expect(JSON.stringify(list)).not.toContain(SECRET);
    expect(JSON.stringify(list)).not.toContain("otherFakeSecret9");
    expect(list.personas[0]).toMatchObject({ name: "a", username: "A", isDefault: true });
    expect(list.env).toMatchObject({ name: "env", icon: ":ghost:", teamId: "T0OTHER01" });
  });
});

// ── Choosing and posting ─────────────────────────────────

describe("resolvePersona", () => {
  beforeEach(() => {
    addPersona({ name: "global", url: URL_WORK, username: "Global" });
    addPersona({ name: "acme", url: URL_OTHER, username: "Acme", workspace: "acme" });
  });

  it("follows the order: named > SLACKER_WEBHOOK_PERSONA > SLACKER_WEBHOOK_URL > workspace default > default", () => {
    expect(resolvePersona()).toMatchObject({ name: "global", source: "default" });
    expect(resolvePersona({ workspace: "acme" })).toMatchObject({ name: "acme", source: "workspace_default" });
    process.env.SLACKER_WEBHOOK_URL = URL_OTHER;
    process.env.SLACKER_WEBHOOK_USERNAME = "From Env";
    expect(resolvePersona({ workspace: "acme" })).toMatchObject({ name: "env", source: "env_url", username: "From Env", teamId: "T0OTHER01" });
    process.env.SLACKER_WEBHOOK_PERSONA = "acme";
    expect(resolvePersona()).toMatchObject({ name: "acme", source: "env_persona" });
    expect(resolvePersona({ persona: "global" })).toMatchObject({ name: "global", source: "named" });
  });

  it("with a workspace in use that has no default, uses the global default only when it's on that team", () => {
    // "global" is team T0WORK001; config.json says "work" is T0WORK001 too.
    expect(resolvePersona({ workspace: "work" }, { configFile: cfg.file })).toMatchObject({ name: "global", workspace: "work" });
    expect(() => resolvePersona({ workspace: "nosuch" }, { configFile: cfg.file })).toThrow(/can't tell which team workspace "nosuch" is.*webhook default <persona> -w nosuch/s);
    setDefaultPersona("acme"); // team T0OTHER01
    expect(() => resolvePersona({ workspace: "work" }, { configFile: cfg.file })).toThrow(/posts into team T0OTHER01, but workspace "work" is team T0WORK001/);
    expect(resolvePersona({ workspace: "work", persona: "acme" }, { configFile: cfg.file }).name).toBe("acme"); // naming one is explicit
  });

  it("applies per-message overrides", () => {
    expect(resolvePersona({ username: "Override", icon: "fire", channel: "alerts" })).toMatchObject({
      name: "global",
      username: "Override",
      icon: ":fire:",
      channel: "#alerts",
    });
  });

  it("names the bad env variable", () => {
    process.env.SLACKER_WEBHOOK_URL = "https://example.com/hook";
    expect(() => resolvePersona()).toThrow(/^SLACKER_WEBHOOK_URL: /);
  });

  it("explains how to set one up when there are none", () => {
    removePersona("global");
    removePersona("acme");
    expect(() => resolvePersona()).toThrow(/No webhook personas configured\. Add one with: slacker webhook add/);
  });
});

describe("sendWebhook", () => {
  const persona = () => resolvePersona({ persona: "bot" });
  beforeEach(() => void addPersona({ name: "bot", url: URL_WORK, username: "Deploy Bot", icon: "rocket", channel: "deploys" }));

  it("posts the text with the persona's name, icon and channel", async () => {
    const posts = stubFetch();
    const r = await sendWebhook(persona(), "Build 142 is live");
    expect(posts).toEqual([{ url: URL_WORK, body: { text: "Build 142 is live", username: "Deploy Bot", icon_emoji: ":rocket:", channel: "#deploys" } }]);
    expect(r).toMatchObject({ dryRun: false, persona: "bot", username: "Deploy Bot", channel: "#deploys", teamId: "T0WORK001" });
    expect(JSON.stringify(r)).not.toContain(SECRET);
  });

  it("uses icon_url for an image icon", async () => {
    const posts = stubFetch();
    await sendWebhook(resolvePersona({ persona: "bot", icon: "https://example.com/logo.png" }), "hi");
    expect(posts[0].body).toMatchObject({ icon_url: "https://example.com/logo.png" });
    expect(posts[0].body).not.toHaveProperty("icon_emoji");
  });

  it("does nothing on a dry run", async () => {
    const posts = stubFetch();
    expect(await sendWebhook(persona(), "hi", { dryRun: true })).toMatchObject({ dryRun: true, text: "hi" });
    expect(posts).toEqual([]);
  });

  it.each([
    [404, "channel_not_found", /channel_not_found — The channel doesn't exist.*NOT posted/],
    [403, "invalid_token", /removed or disabled in Slack.*slacker webhook add/],
    [429, "", /rate_limited.*NOT posted/],
    [500, "<html>oops</html>", /http_500 — the message may or may not have been posted/],
  ])("maps HTTP %i %s to a clear error", async (status, body, message) => {
    stubFetch(status, body);
    await expect(sendWebhook(persona(), "hi")).rejects.toThrow(message);
  });

  it("never puts the URL in a network error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError(`fetch failed for ${URL_WORK}`, { cause: { code: "ECONNREFUSED" } });
      })
    );
    const err = (await sendWebhook(persona(), "hi").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("Network error posting to the webhook: ECONNREFUSED — the message was NOT posted.");
  });

  it("reports a timeout as maybe-posted, and a cancel before the request or an unreachable network as NOT posted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true }))
      )
    );
    await expect(sendWebhook(persona(), "hi", { timeoutMs: 20 })).rejects.toThrow("timed out after 20ms — the message may or may not have been posted");
    const controller = new AbortController();
    controller.abort();
    await expect(sendWebhook(persona(), "hi", { signal: controller.signal })).rejects.toThrow("Cancelled before posting to the webhook — the message was NOT posted.");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed", { cause: { code: "ENETUNREACH" } });
      })
    );
    await expect(sendWebhook(persona(), "hi")).rejects.toThrow("ENETUNREACH — the message was NOT posted.");
  });

  it("refuses empty text before posting", async () => {
    const posts = stubFetch();
    await expect(sendWebhook(persona(), "  ")).rejects.toThrow(/empty/);
    expect(posts).toEqual([]);
  });
});

// ── CLI ──────────────────────────────────────────────────

function fakeStdin(text = "", tty = false): CliIO["stdin"] {
  const s = new PassThrough();
  s.end(text);
  return Object.assign(s, { isTTY: tty });
}

async function cli(args: string[], o: { stdin?: CliIO["stdin"]; cwd?: string } = {}) {
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
  try {
    await main(["node", "slacker", "-c", cfg.file, ...args], { stdin: o.stdin ?? fakeStdin(), cwd: o.cwd ?? dir });
  } finally {
    for (const s of spies) s.mockRestore();
    exit.mockRestore();
  }
  return { code, stdout: out.join(""), stderr: err.join("") };
}

describe("slacker webhook (CLI)", () => {
  it("add reads the URL from stdin, never prints it, and shows the persona", async () => {
    const r = await cli(["webhook", "add", "deploy-bot", "--username", "Deploy Bot", "--icon", "rocket", "--channel", "deploys"], { stdin: fakeStdin(`${URL_WORK}\n`) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Added persona "deploy-bot"');
    expect(r.stdout).toContain('"Deploy Bot" :rocket:');
    expect(r.stdout).toContain('posts to #deploys · team T0WORK001 (workspace "work", matched in config.json)');
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(loadWebhooks().personas["deploy-bot"].url).toBe(URL_WORK);
  });

  it("add refuses --url (secrets stay out of argv) without echoing it", async () => {
    const r = await cli(["--json", "webhook", "add", "b", "--url", URL_WORK]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe("secret_in_argv");
    expect(r.stdout + r.stderr).not.toContain(SECRET);
    expect(loadWebhooks().personas).toEqual({});
  });

  it("add ignores SLACKER_WEBHOOK_URL (it defines the ad-hoc persona) and says when a URL is replaced", async () => {
    process.env.SLACKER_WEBHOOK_URL = URL_OTHER;
    let r = await cli(["webhook", "add", "a"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Expected the webhook URL on stdin");
    expect((await cli(["webhook", "add", "a"], { stdin: fakeStdin(URL_WORK) })).code).toBe(0);
    expect(loadWebhooks().personas.a.url).toBe(URL_WORK);
    delete process.env.SLACKER_WEBHOOK_URL;
    r = await cli(["webhook", "add", "a", "--force"], { stdin: fakeStdin(URL_OTHER) });
    expect(r.stdout).toContain("Webhook URL replaced.");
    expect(r.stdout).not.toContain("Now the default persona"); // only said when this call made it the default
  });

  it("add checks the other options before asking for the URL", async () => {
    // A TTY without raw mode: reaching the prompt would fail with no_tty instead.
    const r = await cli(["--json", "webhook", "add", "a", "--icon", "not an emoji"], { stdin: fakeStdin("", true) });
    expect(JSON.parse(r.stdout).error.message).toContain('Invalid icon "not an emoji"');
  });

  it("--url with a URL as the persona name doesn't print either", async () => {
    const r = await cli(["webhook", "add", URL_OTHER, "--url", "x"]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toContain("otherFakeSecret9");
  });

  it("a webhook URL given as a persona name is refused without being printed", async () => {
    addPersona({ name: "a", url: URL_WORK });
    for (const args of [["webhook", "default", URL_OTHER], ["webhook", "remove", URL_OTHER], ["webhook", "send", "-p", URL_OTHER, "hi"], ["webhook", "add", URL_OTHER]]) {
      const r = await cli(["--json", ...args]);
      expect(JSON.parse(r.stdout).error.code, args.join(" ")).toBe("secret_in_argv");
      expect(r.stdout + r.stderr).not.toContain("otherFakeSecret9");
    }
  });

  it("add --keep-url updates without asking for the URL", async () => {
    addPersona({ name: "a", url: URL_WORK });
    const r = await cli(["webhook", "add", "a", "--keep-url", "--icon", "eyes"]);
    expect(r.code).toBe(0);
    expect(loadWebhooks().personas.a).toMatchObject({ url: URL_WORK, icon: ":eyes:" });
    expect((await cli(["webhook", "add", "new", "--keep-url"])).stderr).toContain("doesn't exist yet");
  });

  it("send posts as the default persona, or the -w workspace's default", async () => {
    addPersona({ name: "global", url: URL_WORK, username: "Global" });
    addPersona({ name: "acme", url: URL_OTHER, username: "Acme", workspace: "acme" });
    const posts = stubFetch();
    const r = await cli(["webhook", "send", "hello"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('✓ Posted as "Global"');
    expect((await cli(["-w", "acme", "webhook", "send", "hi acme", "--channel", "oncall"])).code).toBe(0);
    expect(posts.map((p) => [p.url, p.body])).toEqual([
      [URL_WORK, { text: "hello", username: "Global" }],
      [URL_OTHER, { text: "hi acme", username: "Acme", channel: "#oncall" }],
    ]);
  });

  it("send --dry-run shows who would post where; --json works", async () => {
    addPersona({ name: "bot", url: URL_WORK, username: "Bot", icon: "robot_face" });
    const posts = stubFetch();
    const r = await cli(["webhook", "send", "-p", "bot", "--dry-run", "check"]);
    expect(r.stdout).toContain('Would post as "Bot" :robot_face: (persona "bot")');
    expect(r.stdout).toContain("the webhook's own channel");
    expect(r.stdout).toContain("Dry run — nothing was posted.");
    const j = JSON.parse((await cli(["--json", "webhook", "send", "-p", "bot", "--dry-run", "check"])).stdout);
    expect(j).toMatchObject({ dryRun: true, persona: "bot", text: "check" });
    expect(posts).toEqual([]);
  });

  it("send reads stdin with - and refuses unquoted words", async () => {
    addPersona({ name: "bot", url: URL_WORK });
    const posts = stubFetch();
    expect((await cli(["webhook", "send", "-"], { stdin: fakeStdin("from a pipe\n") })).code).toBe(0);
    expect(posts[0].body.text).toBe("from a pipe");
    const r = await cli(["webhook", "send", "two", "words"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Quote the message: slacker webhook send "your message"');
  });

  it("send is refused in a read-only project (a dry run still works)", async () => {
    addPersona({ name: "bot", url: URL_WORK });
    const posts = stubFetch();
    writeFileSync(join(dir, ".slacker.json"), JSON.stringify({ readOnly: true }));
    const r = await cli(["webhook", "send", "hi"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Refusing to post: this project is read-only");
    expect((await cli(["webhook", "send", "--dry-run", "hi"])).code).toBe(0);
    expect(posts).toEqual([]);
  });

  it("send is refused, dry runs too, when an untrusted .slacker.json picks the workspace; -w bypasses it", async () => {
    addPersona({ name: "bot", url: URL_WORK, workspace: "work" });
    const posts = stubFetch();
    writeFileSync(join(dir, ".slacker.json"), JSON.stringify({ workspace: "work" }));
    for (const args of [["webhook", "send", "hi"], ["webhook", "send", "--dry-run", "hi"]]) {
      const r = await cli(["--json", ...args]);
      expect(JSON.parse(r.stdout).error.code).toBe("untrusted_project");
    }
    const refused = await cli(["webhook", "send", "hi"]);
    expect(refused.stderr).toContain("Or name the persona to post as (-p/--persona)");
    expect((await cli(["-w", "work", "webhook", "send", "hi"])).code).toBe(0);
    expect((await cli(["webhook", "send", "-p", "bot", "named, so the file doesn't matter"])).code).toBe(0);
    expect(posts).toHaveLength(2);
  });

  it("send is refused, dry runs too, when someone else could change the .slacker.json", async () => {
    addPersona({ name: "bot", url: URL_WORK });
    stubFetch();
    const project = join(dir, ".slacker.json");
    writeFileSync(project, JSON.stringify({ readOnly: false }));
    chmodSync(project, 0o666);
    const r = await cli(["--json", "webhook", "send", "--dry-run", "hi"]);
    expect(JSON.parse(r.stdout).error.code).toBe("untrusted_project");
  });

  it("strips terminal escapes from a hand-edited persona in human output", async () => {
    addPersona({ name: "a", url: URL_WORK });
    const store = JSON.parse(readFileSync(file, "utf-8"));
    store.personas.a.username = "\u001b[2JEvil\u202e";
    writeFileSync(file, JSON.stringify(store), { mode: 0o600 });
    const r = await cli(["webhook", "list"]);
    expect(r.stdout).toContain("Evil");
    expect(r.stdout).not.toContain("\u001b[2J");
    expect(r.stdout).not.toContain("\u202e");
  });

  it("explains -- for webhook text that starts with -", async () => {
    addPersona({ name: "a", url: URL_WORK });
    const r = await cli(["webhook", "send", "-1 is wrong"]);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('slacker webhook send -- "-1 from me"');
  });

  it("list hides secrets; default and remove work", async () => {
    addPersona({ name: "a", url: URL_WORK, username: "A" });
    addPersona({ name: "b", url: URL_OTHER });
    let r = await cli(["webhook", "list"]);
    expect(r.stdout).toMatch(/\* a\s+"A"/);
    expect(r.stdout).not.toContain(SECRET);
    expect((await cli(["webhook", "default", "b"])).stdout).toContain("Default persona: b");
    expect((await cli(["webhook", "default"])).stderr).toContain("Name a persona, or pass --unset");
    expect((await cli(["-w", "nowhere", "webhook", "default", "--unset"])).stdout).toContain("nothing changed");
    r = await cli(["webhook", "remove", "b"]);
    expect(r.stdout).toContain('Removed persona "b"');
    expect(loadWebhooks().defaultPersona).toBeNull();
  });

  it("serve --webhook-only is passed to the server", async () => {
    await cli(["serve", "--webhook-only"]);
    expect(vi.mocked(startServer)).toHaveBeenCalledWith(expect.objectContaining({ webhookOnly: true }));
  });
});

// ── MCP ──────────────────────────────────────────────────

async function connect(opts: ServerOptions) {
  const created = createServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([created.server.connect(serverTransport), client.connect(clientTransport)]);
  cleanups.push(async () => {
    await client.close();
    await created.server.close();
  });
  return client;
}

type ToolResult = { isError?: boolean; content: Array<{ text: string }> };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const names = async (client: Client) => (await client.listTools()).tools.map((t) => t.name).sort();

describe("MCP webhook tools", () => {
  it("--webhook-only serves just the webhook tools and posts from SLACKER_WEBHOOK_URL with no slack-cli config", async () => {
    process.env.SLACKER_WEBHOOK_URL = URL_WORK;
    process.env.SLACKER_WEBHOOK_USERNAME = "CI Bot";
    process.env.SLACKER_WEBHOOK_ICON = "robot_face";
    const posts = stubFetch();
    const client = await connect({ webhookOnly: true, configFile: join(dir, "missing.json"), cwd: dir });
    expect(await names(client)).toEqual(["list_webhook_personas", "send_webhook_message"]);
    expect(client.getInstructions()).toMatch(/only posts through Slack incoming webhooks/);
    const r = await call(client, "send_webhook_message", { text: "deployed", channel: "releases" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ persona: "env", username: "CI Bot", channel: "#releases" });
    expect(posts[0].body).toEqual({ text: "deployed", username: "CI Bot", icon_emoji: ":robot_face:", channel: "#releases" });
    expect(r.content[0].text).not.toContain(SECRET);
  });

  it("works next to unconfigured Slack tools, and picks the persona by name", async () => {
    addPersona({ name: "a", url: URL_WORK, username: "A" });
    addPersona({ name: "b", url: URL_OTHER, username: "B" });
    const posts = stubFetch();
    const client = await connect({ workspace: "nope", configFile: join(dir, "missing.json"), cwd: dir });
    expect(client.getInstructions()).toMatch(/every Slack tool \(all but the webhook tools\)/);
    expect((await call(client, "whoami")).isError).toBe(true);
    expect((await call(client, "send_webhook_message", { text: "x", persona: "b" })).isError).toBeFalsy();
    expect(posts[0]).toMatchObject({ url: URL_OTHER, body: { username: "B" } });
    const list = JSON.parse((await call(client, "list_webhook_personas")).content[0].text);
    expect(list.personas.map((p: { name: string }) => p.name)).toEqual(["a", "b"]);
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it("hides send_webhook_message in read-only mode and refuses when the project becomes read-only", async () => {
    addPersona({ name: "a", url: URL_WORK });
    const posts = stubFetch();
    expect(await names(await connect({ webhookOnly: true, readOnly: true, cwd: dir }))).toEqual(["list_webhook_personas"]);
    const client = await connect({ webhookOnly: true, cwd: dir });
    writeFileSync(join(dir, ".slacker.json"), JSON.stringify({ readOnly: true }));
    const r = await call(client, "send_webhook_message", { text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("Refusing to post: this project is read-only");
    writeFileSync(join(dir, ".slacker.json"), "{not json");
    expect((await call(client, "send_webhook_message", { text: "x" })).isError).toBe(true);
    expect(posts).toEqual([]);
  });

  it("refuses posts (dry runs too) when an untrusted .slacker.json picks the workspace, and says so up front", async () => {
    addPersona({ name: "a", url: URL_WORK });
    const posts = stubFetch();
    writeFileSync(join(dir, ".slacker.json"), JSON.stringify({ workspace: "work" }));
    const { chooseWorkspace } = await import("../src/config.js");
    const client = await connect({ webhookOnly: true, cwd: dir, choice: chooseWorkspace(undefined, dir), configFile: cfg.file });
    expect(client.getInstructions()).toMatch(/When the server started, posting refused/);
    for (const dry_run of [false, true]) {
      const r = await call(client, "send_webhook_message", { text: "x", dry_run });
      expect(r.isError).toBe(true);
      expect(r.content[0].text).toContain("isn't trusted on this machine");
      expect(r.content[0].text).toContain("Or name the persona to post as (the persona parameter)");
    }
    expect(posts).toEqual([]);
  });

  it("an untrusted .slacker.json doesn't block a persona that doesn't depend on it (SLACKER_WEBHOOK_URL, or named)", async () => {
    addPersona({ name: "a", url: URL_OTHER });
    const posts = stubFetch();
    writeFileSync(join(dir, ".slacker.json"), JSON.stringify({ workspace: "acme" })); // acme isn't even in config.json
    process.env.SLACKER_WEBHOOK_URL = URL_WORK;
    const { chooseWorkspace } = await import("../src/config.js");
    const client = await connect({ webhookOnly: true, cwd: dir, choice: chooseWorkspace(undefined, dir), configFile: cfg.file });
    expect((await call(client, "send_webhook_message", { text: "env persona" })).isError).toBeFalsy();
    expect((await call(client, "send_webhook_message", { text: "named", persona: "a" })).isError).toBeFalsy();
    expect(posts.map((p) => p.url)).toEqual([URL_WORK, URL_OTHER]);
  });

  it("full mode with a corrupt .slacker.json at startup says the webhook tools refuse too", async () => {
    const client = await connect({ configFile: cfg.file, cwd: dir, startupError: "Could not parse /x/.slacker.json" });
    expect(client.getInstructions()).toMatch(/every tool, the webhook tools' posting included, returns an error/);
  });

  it("webhook-only with a corrupt .slacker.json at startup explains it and refuses posts", async () => {
    addPersona({ name: "a", url: URL_WORK });
    const posts = stubFetch();
    writeFileSync(join(dir, ".slacker.json"), "{oops");
    const client = await connect({ webhookOnly: true, cwd: dir, startupError: "Could not parse /x/.slacker.json" });
    expect(client.getInstructions()).toMatch(/project settings couldn't be read.*Could not parse/);
    expect((await call(client, "send_webhook_message", { text: "x" })).isError).toBe(true);
    expect(posts).toEqual([]);
  });

  it("a server started with --workspace won't fall back to a default persona on another team", async () => {
    addPersona({ name: "other", url: URL_OTHER });
    stubFetch();
    const client = await connect({ webhookOnly: true, workspace: "work", configFile: cfg.file, cwd: dir });
    const r = await call(client, "send_webhook_message", { text: "x" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/Workspace "work" has no default webhook persona/);
  });

  it("send_webhook_message accepts a per-message bot name and icon, validated like the CLI's", async () => {
    addPersona({ name: "a", url: URL_WORK, username: "A", icon: "eyes" });
    const posts = stubFetch();
    const client = await connect({ webhookOnly: true, cwd: dir });
    const r = await call(client, "send_webhook_message", { text: "x", username: "Release Bot", icon: "tada" });
    expect(r.isError).toBeFalsy();
    expect(JSON.parse(r.content[0].text)).toMatchObject({ persona: "a", username: "Release Bot", icon: ":tada:" });
    expect(posts[0].body).toEqual({ text: "x", username: "Release Bot", icon_emoji: ":tada:" });
    expect((await call(client, "send_webhook_message", { text: "x", icon: "https://example.com/logo.png", dry_run: true })).content[0].text).toContain('"icon":"https://example.com/logo.png"');
    const bad = await call(client, "send_webhook_message", { text: "x", username: "line\nbreak" });
    expect(bad.isError).toBe(true);
    expect((await call(client, "send_webhook_message", { text: "x", icon: URL_OTHER })).content[0].text).not.toContain("otherFakeSecret9");
    expect(posts).toHaveLength(1);
    const tool = (await client.listTools()).tools.find((t) => t.name === "send_webhook_message")!;
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(expect.arrayContaining(["username", "icon"]));
    expect(tool.description).toMatch(/only when the user asked for that name or icon, never to pose as a real person/);
  });

  it("reports a missing persona with the available names", async () => {
    addPersona({ name: "a", url: URL_WORK });
    stubFetch();
    const client = await connect({ webhookOnly: true, cwd: dir });
    const r = await call(client, "send_webhook_message", { text: "x", persona: "zzz" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/No webhook persona "zzz".*Available: "a"/);
  });
});

it("the stored file holds exactly what was configured", () => {
  addPersona({ name: "a", url: URL_WORK, username: "A", icon: "eyes" });
  expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({
    version: 1,
    defaultPersona: "a",
    workspaceDefaults: {},
    personas: { a: { url: URL_WORK, username: "A", icon: ":eyes:" } },
  });
});
