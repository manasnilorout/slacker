/**
 * Fake Slack Web API for tests: replaces `globalThis.fetch` so no request leaves the process.
 *
 *   const slack = installSlackStub();                       // sensible defaults (auth.test, chat.*, …)
 *   slack.on("conversations.list", (p) => paginate(channels, "channels", p));
 *   slack.fail("users.info", "user_not_found");
 *   …exercise SlackSession / SlackAPI / CLI / server…
 *   expect(slack.count("chat.postMessage")).toBe(0);
 *   slack.restore();                                         // or rely on afterEach(restoreAll)
 *
 * Handlers receive the decoded form params and return the response body. `ok: true` is added
 * when the body has no `ok` key; return `slackError(code)` for `{ ok: false, error }`, or a real
 * `Response` to control status/headers (e.g. HTTP 429). Unhandled methods answer
 * `stub_unhandled_method` so a missing handler fails loudly instead of looking like success.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Params = Record<string, string>;
export type Handler = (params: Params, call: StubCall) => unknown | Promise<unknown>;

export interface StubCall {
  method: string;
  params: Params;
  headers: Record<string, string>;
}

export interface SlackStub {
  /** Every request, in order. */
  readonly calls: StubCall[];
  /** Highest number of requests in flight at once (meaningful with `delayMs`). */
  readonly maxInFlight: number;
  /** Register/replace a handler. A non-function value is returned as the body for every call. */
  on(method: string, handler: Handler | Record<string, unknown>): SlackStub;
  /** Make `method` answer `{ ok: false, error: code }`. */
  fail(method: string, code: string): SlackStub;
  /** Number of calls to `method` (or all calls). */
  count(method?: string): number;
  /** Calls to `method`. */
  callsTo(method: string): StubCall[];
  /** Method names called, in order. */
  methods(): string[];
  /** Forget recorded calls (handlers stay). */
  reset(): void;
  /** Put the original fetch back. */
  restore(): void;
}

export interface StubOptions {
  /** Artificial latency per request in ms (lets concurrency tests observe overlap). */
  delayMs?: number;
  /** Install the default handlers below (default true). */
  defaults?: boolean;
  /** Identity returned by auth.test. */
  identity?: Partial<{ team: string; user: string; team_id: string; user_id: string; url: string; enterprise_id: string }>;
}

export const DEFAULT_IDENTITY = {
  team: "Work",
  user: "me",
  team_id: "T0WORK001",
  user_id: "U0MEMEME1",
  url: "https://work.slack.com/",
};

export function slackError(code: string, extra: Record<string, unknown> = {}) {
  return { ok: false, error: code, ...extra };
}

/**
 * Cursor pagination over `items` the way Slack does it: honours `params.limit` (or `pageSize`)
 * and `params.cursor`; the cursor is an opaque offset string, empty on the last page.
 */
export function paginate<T>(items: T[], key: string, params: Params, pageSize?: number) {
  const size = Math.max(1, pageSize ?? (Number(params.limit) || 100));
  const start = params.cursor ? Number(params.cursor) : 0;
  const end = start + size;
  return {
    ok: true,
    [key]: items.slice(start, end),
    response_metadata: { next_cursor: end < items.length ? String(end) : "" },
  };
}

/** A minimal users.info-shaped user. */
export function makeUser(id: string, name: string, realName = name, extra: Record<string, unknown> = {}) {
  return { id, name, real_name: realName, profile: { display_name: name, real_name: realName }, ...extra };
}

const installed: Array<() => void> = [];

/** Restore every stub installed so far (handy in afterEach). */
export function restoreAll(): void {
  while (installed.length) installed.pop()!();
}

export function installSlackStub(opts: StubOptions = {}): SlackStub {
  const original = globalThis.fetch;
  const handlers = new Map<string, Handler>();
  const calls: StubCall[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const identity = { ...DEFAULT_IDENTITY, ...opts.identity };

  if (opts.defaults !== false) {
    handlers.set("auth.test", () => identity);
    handlers.set("chat.postMessage", (p) => ({ channel: p.channel, ts: "1760000000.000100" }));
    handlers.set("chat.getPermalink", (p) => ({ permalink: `${identity.url}archives/${p.channel}/p${p.message_ts?.replace(".", "")}` }));
    handlers.set("chat.update", (p) => ({ channel: p.channel, ts: p.ts }));
    handlers.set("chat.delete", (p) => ({ channel: p.channel, ts: p.ts }));
    handlers.set("reactions.add", () => ({}));
    handlers.set("users.profile.set", () => ({}));
    handlers.set("conversations.open", (p) => ({ channel: { id: `D0${p.users.replace(/[^A-Z0-9]/g, "").slice(-8)}` } }));
    handlers.set("conversations.info", (p) => ({ channel: { id: p.channel, name: `name-of-${p.channel.toLowerCase()}` } }));
    handlers.set("conversations.history", () => ({ messages: [], has_more: false }));
    handlers.set("conversations.replies", () => ({ messages: [], has_more: false }));
    handlers.set("users.conversations", (p) => paginate([], "channels", p));
    handlers.set("conversations.list", (p) => paginate([], "channels", p));
    handlers.set("users.list", (p) => paginate([], "members", p));
    handlers.set("search.modules", () => ({ items: [] }));
    handlers.set("users.info", () => slackError("user_not_found"));
    handlers.set("users.lookupByEmail", () => slackError("users_not_found"));
  }

  const stubFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const method = url.split("/api/")[1]?.split("?")[0] ?? url;
    const body = init?.body;
    const params = Object.fromEntries(new URLSearchParams(typeof body === "string" ? body : (body?.toString() ?? "")));
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const call: StubCall = { method, params, headers };
    calls.push(call);
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      const handler = handlers.get(method);
      const result = handler ? await handler(params, call) : slackError("stub_unhandled_method", { method });
      if (result instanceof Response) return result;
      const json = typeof result === "object" && result !== null && !("ok" in result) ? { ok: true, ...result } : result;
      return new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } });
    } finally {
      inFlight--;
    }
  };

  globalThis.fetch = stubFetch as typeof fetch;
  const restore = () => {
    if (globalThis.fetch === stubFetch) globalThis.fetch = original;
  };
  installed.push(restore);

  const stub: SlackStub = {
    calls,
    get maxInFlight() {
      return maxInFlight;
    },
    on(method, handler) {
      handlers.set(method, typeof handler === "function" ? handler : () => handler);
      return stub;
    },
    fail(method, code) {
      handlers.set(method, () => slackError(code));
      return stub;
    },
    count: (method) => (method ? calls.filter((c) => c.method === method).length : calls.length),
    callsTo: (method) => calls.filter((c) => c.method === method),
    methods: () => calls.map((c) => c.method),
    reset: () => {
      calls.length = 0;
      maxInFlight = 0;
    },
    restore,
  };
  return stub;
}

export interface TempConfig {
  file: string;
  dir: string;
  cleanup(): void;
}

/**
 * Write a throwaway slack-cli config.json (never the real one). Workspaces default to a single
 * "work" entry matching DEFAULT_IDENTITY. Call `cleanup()` (e.g. in afterAll).
 */
export function writeTempConfig(
  workspaces: Record<string, Partial<{ token: string; cookie: string; url: string; userId: string; teamId: string }>> = {
    work: {},
  },
  defaultWorkspace: string | null = Object.keys(workspaces)[0] ?? null
): TempConfig {
  const dir = mkdtempSync(join(tmpdir(), "slacker-test-"));
  const file = join(dir, "config.json");
  const full = Object.fromEntries(
    Object.entries(workspaces).map(([name, ws]) => [
      name,
      {
        token: "xoxc-test-token",
        cookie: "xoxd-test-cookie",
        url: DEFAULT_IDENTITY.url,
        userId: DEFAULT_IDENTITY.user_id,
        teamId: DEFAULT_IDENTITY.team_id,
        ...ws,
      },
    ])
  );
  writeFileSync(file, JSON.stringify({ workspaces: full, defaultWorkspace }), { mode: 0o600 });
  return { file, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
