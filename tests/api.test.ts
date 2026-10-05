import { describe, it, expect, afterEach, vi } from "vitest";
import { AUTH_ERROR_CODES, formatDuration, isAuthError, SlackAPI, SlackApiError, SlackNetworkError, retryAfterMs } from "../src/api.js";
import { SlackerError } from "../src/errors.js";
import { setActiveConfig } from "../src/command.js";

const TOKEN = "xoxc-SECRET-TOKEN";
const COOKIE = "xoxd-SECRET-COOKIE";
const realFetch = globalThis.fetch;

type Responder = (n: number, init: RequestInit) => Response | Promise<Response>;

/** Stub fetch; returns a call counter. */
function stubFetch(responder: Responder) {
  const calls: RequestInit[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init!);
    return responder(calls.length, init!);
  }) as typeof fetch;
  return calls;
}

const R = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });
const OK = () => R('{"ok":true,"team":"Acme"}');

function api(opts: { maxRetries?: number; timeoutMs?: number; deadlineMs?: number } = {}) {
  const waits: number[] = [];
  const client = new SlackAPI(TOKEN, COOKIE, { ...opts, sleep: async (ms) => void waits.push(ms) });
  return { client, waits };
}

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    expect(String((e as Error).message)).not.toContain("SECRET");
    return e as Error;
  }
  throw new Error("expected rejection");
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  setActiveConfig(undefined);
});

const reset = () => {
  throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
};
/** A fetch that only settles when its signal aborts. */
const hang = ((_u: unknown, init?: RequestInit) =>
  new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))) as typeof fetch;

describe("SlackAPI request", () => {
  it("posts form-encoded params with bearer token and d cookie", async () => {
    let url = "";
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      url = String(u);
      const headers = init!.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(headers.Cookie).toBe(`d=${COOKIE}`);
      expect(headers["Content-Type"]).toMatch(/x-www-form-urlencoded/);
      expect(String(init!.body)).toBe("channel=C1&limit=5&inclusive=true");
      expect(init!.signal).toBeInstanceOf(AbortSignal);
      return OK();
    }) as typeof fetch;
    const { client } = api();
    await expect(client.call("conversations.history", { channel: "C1", limit: 5, inclusive: true, skip: undefined })).resolves.toMatchObject({ ok: true });
    expect(url).toBe("https://slack.com/api/conversations.history");
  });
});

describe("SlackAPI errors", () => {
  it("times out a hung request", async () => {
    globalThis.fetch = ((_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))) as typeof fetch;
    const { client } = api({ timeoutMs: 20, maxRetries: 0 });
    const e = await failure(client.call("auth.test"));
    expect(e).toBeInstanceOf(SlackNetworkError);
    expect(e.message).toMatch(/Network error calling auth\.test: timed out after/);
  });

  it("retries a timeout for read methods", async () => {
    let n = 0;
    globalThis.fetch = ((_u: unknown, init?: RequestInit) =>
      ++n === 1
        ? new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))
        : Promise.resolve(OK())) as typeof fetch;
    const { client } = api({ timeoutMs: 20 });
    await expect(client.call("auth.test")).resolves.toMatchObject({ ok: true });
    expect(n).toBe(2);
  });

  it("wraps network errors with their cause", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND slack.com"), { code: "ENOTFOUND" });
    const calls = stubFetch(() => {
      throw new TypeError("fetch failed", { cause });
    });
    const { client } = api();
    const e = await failure(client.call("auth.test"));
    expect(e).toBeInstanceOf(SlackNetworkError);
    expect(e.message).toBe("Network error calling auth.test: ENOTFOUND");
    expect((e.cause as Error).cause).toBe(cause);
    expect(calls).toHaveLength(1); // ENOTFOUND isn't transient
  });

  it("retries transient network errors then gives up", async () => {
    const calls = stubFetch(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }) });
    });
    const { client, waits } = api();
    const e = await failure(client.call("conversations.history"));
    expect(e.message).toMatch(/ECONNRESET/);
    expect(calls).toHaveLength(4);
    expect(waits).toHaveLength(3);
  });

  it("does not retry an ambiguous failure of chat.postMessage (could double-post)", async () => {
    const calls = stubFetch(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) });
    });
    const { client } = api();
    await failure(client.call("chat.postMessage", { channel: "C1", text: "hi" }));
    expect(calls).toHaveLength(1);
  });

  it("reports a non-JSON 5xx with its status and no body", async () => {
    stubFetch(() => R("<html>Bad gateway token=xoxc-leak</html>", 502));
    const e = await failure(api().client.call("auth.test"));
    expect(e.message).toMatch(/HTTP 502 with a non-JSON response/);
    expect(e.message).not.toContain("xoxc");
    expect(e).toBeInstanceOf(SlackerError);
    expect((e as SlackerError).code).toBe("http_error"); // F7: --json gets a code
  });

  it("rejects a JSON body that isn't an object", async () => {
    stubFetch(() => R("null"));
    const e = await failure(api().client.call("auth.test"));
    expect(e.message).toMatch(/unexpected response/);
  });

  it("raises SlackApiError with code and response", async () => {
    stubFetch(() => R('{"ok":false,"error":"channel_not_found"}'));
    const e = await failure(api().client.call("conversations.info"));
    expect(e).toBeInstanceOf(SlackApiError);
    expect(e).toMatchObject({ method: "conversations.info", code: "channel_not_found", response: { ok: false } });
  });

  it("hints refresh-then-setup for invalid_auth", async () => {
    stubFetch(() => R('{"ok":false,"error":"invalid_auth"}'));
    const e = await failure(api().client.call("auth.test"));
    expect(e.message).toMatch(/Run: .+ auth refresh \(then .+ auth setup if it still fails\)/);
    expect(e.message).toMatch(/Keychain/);
  });

  it("hints setup for token_revoked", async () => {
    stubFetch(() => R('{"ok":false,"error":"token_revoked"}'));
    const e = await failure(api().client.call("auth.test"));
    expect(e.message).toMatch(/auth setup/);
    expect(e.message).not.toMatch(/auth refresh/);
  });
});

describe("SlackAPI rate limiting", () => {
  it("waits Retry-After seconds then succeeds", async () => {
    const calls = stubFetch((n) => (n === 1 ? R("", 429, { "retry-after": "2" }) : OK()));
    const { client, waits } = api();
    await expect(client.call("auth.test")).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
    expect(waits[0]).toBeGreaterThanOrEqual(2000);
    expect(waits[0]).toBeLessThan(2300);
  });

  it("handles Retry-After as an HTTP-date", async () => {
    const at = new Date(Date.now() + 5000).toUTCString();
    stubFetch((n) => (n === 1 ? R("", 429, { "retry-after": at }) : OK()));
    const { client, waits } = api();
    await client.call("auth.test");
    expect(waits[0]).toBeGreaterThan(3000);
    expect(waits[0]).toBeLessThan(5300);
  });

  it("waits ~1s on garbage Retry-After and ~0 on 0", async () => {
    stubFetch((n) => (n === 1 ? R("", 429, { "retry-after": "abc" }) : n === 2 ? R("", 429, { "retry-after": "0" }) : OK()));
    const { client, waits } = api();
    await client.call("auth.test");
    expect(waits[0]).toBeGreaterThanOrEqual(1000);
    expect(waits[0]).toBeLessThan(1300);
    expect(waits[1]).toBeLessThan(300);
    expect(waits.every(Number.isFinite)).toBe(true);
  });

  it("caps long waits", () => {
    expect(retryAfterMs("3600")).toBe(60_000);
    expect(retryAfterMs(null)).toBe(1000);
    expect(retryAfterMs("-5")).toBe(1000);
  });

  it("retries HTTP 200 ratelimited", async () => {
    const calls = stubFetch((n) => (n === 1 ? R('{"ok":false,"error":"ratelimited"}') : OK()));
    await expect(api().client.call("auth.test")).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("gives up with ratelimited after maxRetries, whatever the body", async () => {
    const calls = stubFetch(() => R("<html>slow down</html>", 429, { "retry-after": "1" }));
    const { client, waits } = api();
    const e = await failure(client.call("auth.test"));
    expect(e).toBeInstanceOf(SlackApiError);
    expect((e as SlackApiError).code).toBe("ratelimited");
    expect(calls).toHaveLength(4);
    expect(waits).toHaveLength(3);
  });

  it("drains 429 bodies before retrying", async () => {
    const cancelled: boolean[] = [];
    stubFetch((n) => {
      if (n > 1) return OK();
      const body = new ReadableStream({ cancel: () => void cancelled.push(true) });
      return new Response(body, { status: 429, headers: { "retry-after": "0" } });
    });
    await api().client.call("auth.test");
    expect(cancelled).toEqual([true]);
  });

  it("uses real timers by default (no NaN timeouts)", async () => {
    vi.useFakeTimers();
    stubFetch((n) => (n === 1 ? R("", 429, { "retry-after": "Wed, garbage" }) : OK()));
    const p = new SlackAPI(TOKEN, COOKIE).call("auth.test");
    await vi.advanceTimersByTimeAsync(1300);
    await expect(p).resolves.toMatchObject({ ok: true });
  });
});

describe("SlackAPI posting safety", () => {
  it("gives up on a rate-limited post after ~10s of waiting and says it was NOT sent", async () => {
    const calls = stubFetch(() => R("", 429, { "retry-after": "6" }));
    const { client, waits } = api({ maxRetries: 10 });
    const e = await failure(client.call("chat.postMessage", { channel: "C1", text: "hi" }));
    expect(e).toBeInstanceOf(SlackApiError);
    expect((e as SlackApiError).code).toBe("ratelimited");
    expect(e.message).toMatch(/the message was NOT sent; try again later/);
    expect(calls).toHaveLength(2);
    expect(waits).toHaveLength(1);
  });

  it("still retries a post within the rate-limit budget", async () => {
    const calls = stubFetch((n) => (n === 1 ? R('{"ok":false,"error":"ratelimited"}', 200, { "retry-after": "2" }) : OK()));
    await expect(api().client.call("chat.postMessage", { channel: "C1", text: "hi" })).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it("reads keep the normal rate-limit wording", async () => {
    stubFetch(() => R("", 429, { "retry-after": "1" }));
    const e = await failure(api({ maxRetries: 0 }).client.call("conversations.history"));
    expect(e.message).toMatch(/wait a minute/);
    expect(e.message).not.toMatch(/NOT sent/);
  });

  it("flags an ambiguous network failure of a post as possibly posted", async () => {
    stubFetch(reset);
    const e = await failure(api().client.call("chat.postMessage", { channel: "C1", text: "hi" }));
    expect(e).toBeInstanceOf(SlackNetworkError);
    expect(e.message).toMatch(/ECONNRESET — the message may or may not have been posted; check the conversation before retrying\./);
  });

  it("flags a timed-out post as possibly posted", async () => {
    globalThis.fetch = hang;
    const e = await failure(api({ timeoutMs: 20 }).client.call("chat.postMessage", { channel: "C1", text: "hi" }));
    expect(e.message).toMatch(/timed out after .*may or may not have been posted/);
  });

  it("retries a post that never reached Slack, without the ambiguity note", async () => {
    const calls = stubFetch(() => {
      throw new TypeError("fetch failed", { cause: Object.assign(new Error("refused"), { code: "ECONNREFUSED" }) });
    });
    const e = await failure(api().client.call("chat.postMessage", { channel: "C1", text: "hi" }));
    expect(calls).toHaveLength(4);
    expect(e.message).not.toMatch(/may or may not/);
  });

  it("treats message_not_found after an ambiguous chat.delete failure as deleted", async () => {
    const calls = stubFetch((n) => (n === 1 ? reset() : R('{"ok":false,"error":"message_not_found"}')));
    await expect(api().client.call("chat.delete", { channel: "C1", ts: "1.2" })).resolves.toEqual({ ok: true, retried: true });
    expect(calls).toHaveLength(2);
  });

  it("reports message_not_found from a first chat.delete attempt", async () => {
    stubFetch(() => R('{"ok":false,"error":"message_not_found"}'));
    const e = await failure(api().client.call("chat.delete", { channel: "C1", ts: "1.2" }));
    expect(e).toMatchObject({ code: "message_not_found" });
  });
});

describe("SlackAPI 5xx and deadline", () => {
  it("retries a non-JSON 5xx for reads", async () => {
    const calls = stubFetch((n) => (n === 1 ? R("<html>502</html>", 502) : n === 2 ? R("oops", 503) : OK()));
    const { client, waits } = api();
    await expect(client.call("conversations.history", { channel: "C1" })).resolves.toMatchObject({ ok: true });
    expect(calls).toHaveLength(3);
    expect(waits).toHaveLength(2);
  });

  it.each(["chat.update", "chat.delete", "reactions.add", "users.profile.set"])("does not retry a non-JSON 5xx for %s", async (method) => {
    const calls = stubFetch(() => R("<html>504</html>", 504));
    const e = await failure(api().client.call(method));
    expect(e.message).toMatch(/HTTP 504 with a non-JSON response/);
    expect(calls).toHaveLength(1);
  });

  it("says a post hit by a non-JSON 5xx may have been posted", async () => {
    const calls = stubFetch(() => R("<html>503</html>", 503));
    const e = await failure(api().client.call("chat.postMessage", { channel: "C1", text: "hi" }));
    expect(e.message).toMatch(/HTTP 503 .*may or may not have been posted/);
    expect(calls).toHaveLength(1);
  });

  it("stops waiting once the overall deadline would pass", async () => {
    const calls = stubFetch(() => R("", 429, { "retry-after": "30" }));
    const { client, waits } = api({ maxRetries: 10 });
    const e = await failure(client.call("conversations.history"));
    expect((e as SlackApiError).code).toBe("ratelimited");
    expect(calls).toHaveLength(3); // waits 30s + 30s; a third 30s wait would cross 90s
    expect(waits).toHaveLength(2);
  });

  it("does not start a network retry that can't finish before the deadline", async () => {
    let n = 0;
    globalThis.fetch = ((u: unknown, init?: RequestInit) => (n++, hang(u as string, init))) as typeof fetch;
    const e = await failure(api({ timeoutMs: 30, deadlineMs: 100 }).client.call("auth.test"));
    expect(e.message).toMatch(/timed out/);
    expect(n).toBe(1); // backoff (≥500ms) would overrun the 100ms budget
  });
});

describe("SlackAPI abort signal", () => {
  it("does nothing when already aborted", async () => {
    const calls = stubFetch(() => OK());
    const ac = new AbortController();
    ac.abort();
    const e = await failure(api().client.call("auth.test", {}, { signal: ac.signal }));
    expect(e).toBeInstanceOf(SlackNetworkError);
    expect(e.message).toMatch(/aborted/);
    expect(calls).toHaveLength(0);
  });

  it("aborts an in-flight request without retrying", async () => {
    let n = 0;
    globalThis.fetch = ((u: unknown, init?: RequestInit) => (n++, hang(u as string, init))) as typeof fetch;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const e = await failure(api().client.call("conversations.history", {}, { signal: ac.signal }));
    expect(e).toBeInstanceOf(SlackNetworkError);
    expect(e.message).toBe("Network error calling conversations.history: aborted");
    expect(n).toBe(1);
  });

  it("an in-flight post that is aborted may have been posted", async () => {
    globalThis.fetch = hang;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const e = await failure(api().client.call("chat.postMessage", { channel: "C1", text: "x" }, { signal: ac.signal }));
    expect(e.message).toMatch(/aborted — the message may or may not have been posted/);
  });

  it("aborts a pending rate-limit wait (default sleep) and says the post was not sent", async () => {
    const calls = stubFetch(() => R("", 429, { "retry-after": "8" }));
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const started = Date.now();
    const e = await failure(new SlackAPI(TOKEN, COOKIE).call("chat.postMessage", { channel: "C1", text: "x" }, { signal: ac.signal }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(e.message).toMatch(/aborted — the message was NOT sent/);
    expect(calls).toHaveLength(1);
  });

  it("aborts even when an injected sleep ignores the signal", async () => {
    stubFetch(() => R("", 429, { "retry-after": "1" }));
    const client = new SlackAPI(TOKEN, COOKIE, { sleep: () => new Promise(() => {}) });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 10);
    const e = await failure(client.call("auth.test", {}, { signal: ac.signal }));
    expect(e.message).toMatch(/aborted/);
  });

  it("still times out when a caller signal is given", async () => {
    globalThis.fetch = hang;
    const e = await failure(api({ timeoutMs: 20, maxRetries: 0 }).client.call("auth.test", {}, { signal: new AbortController().signal }));
    expect(e.message).toMatch(/timed out after/);
  });
});

describe("SlackAPI hints name the active config", () => {
  it("adds -c for a non-default config file", async () => {
    setActiveConfig("/tmp/slacker test/config.json");
    stubFetch(() => R('{"ok":false,"error":"invalid_auth"}'));
    const e = await failure(api().client.call("auth.test"));
    expect(e.message).toContain("Run: slacker auth refresh");
    expect(e.message).toMatch(/\n\(run slacker as: ".+" ".+index\.js" -c "\/tmp\/slacker test\/config\.json"\)$/);
    expect(e.message.split("(run slacker as:")).toHaveLength(2); // the long form is printed once
  });
});

describe("round 3 polish (F11, F12)", () => {
  it("sub-second timeouts read in ms, not 0s", async () => {
    expect(formatDuration(20)).toBe("20ms");
    expect(formatDuration(1500)).toBe("2s");
    globalThis.fetch = hang;
    const e = await failure(api({ timeoutMs: 20, maxRetries: 0 }).client.call("auth.test"));
    expect(e.message).toMatch(/timed out after 20ms/);
  });

  it("hints are capitalized and exposed separately", () => {
    for (const code of ["invalid_auth", "token_revoked", "ratelimited", "missing_scope", "channel_not_found"]) {
      const e = new SlackApiError("conversations.history", code);
      expect(e.hint).toMatch(/^[A-Z]/);
      expect(e.message).toBe(`Slack API error (conversations.history): ${code} — ${e.hint}`);
    }
    expect(new SlackApiError("x", "some_other_code").hint).toBeUndefined();
  });

  it("one shared set of auth-failure codes", () => {
    expect([...AUTH_ERROR_CODES].sort()).toEqual(["account_inactive", "invalid_auth", "not_authed", "token_expired", "token_revoked"]);
    expect(isAuthError(new SlackApiError("auth.test", "token_revoked"))).toBe(true);
    expect(isAuthError(new SlackApiError("auth.test", "ratelimited"))).toBe(false);
    expect(isAuthError(new Error("invalid_auth"))).toBe(false);
  });
});
