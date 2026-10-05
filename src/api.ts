import { withRunNote } from "./command.js";
import { SlackerError } from "./errors.js";
import { isPlainObject } from "./util.js";

/** Methods that create a message: a retry after an ambiguous failure could post it twice. */
const POST_METHODS = new Set(["chat.postMessage", "chat.meMessage", "chat.postEphemeral", "chat.scheduleMessage"]);
const NOT_SENT = " — the message was NOT sent; try again later.";
const MAYBE_SENT = " — the message may or may not have been posted; check the conversation before retrying.";

/** Methods that change something in Slack: an HTTP 5xx without a Slack response isn't retried for them. */
function isWriteMethod(method: string): boolean {
  return method.startsWith("chat.") || method.startsWith("reactions.") || method === "users.profile.set";
}

/** Slack error codes meaning the session credentials themselves are bad (never worth a fallback). */
export const AUTH_ERROR_CODES: ReadonlySet<string> = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);

export class SlackApiError extends Error {
  /** The next step for this code, when there is one (also appended to `message` after " — "). */
  public readonly hint?: string;

  constructor(
    public readonly method: string,
    public readonly code: string,
    public readonly response?: unknown
  ) {
    const hint = hintFor(code, method);
    super(`Slack API error (${method}): ${code}${hint ? ` — ${hint}` : ""}`);
    this.name = "SlackApiError";
    if (hint) this.hint = hint;
  }
}

/** Did Slack reject the session credentials (invalid_auth, token_revoked, …)? */
export function isAuthError(e: unknown): e is SlackApiError {
  return e instanceof SlackApiError && AUTH_ERROR_CODES.has(e.code);
}

/** The request never produced a Slack response (DNS, connection reset, timeout, abort…). */
export class SlackNetworkError extends Error {
  constructor(
    public readonly method: string,
    message: string,
    cause?: unknown
  ) {
    super(message, { cause });
    this.name = "SlackNetworkError";
  }
}

function hintFor(code: string, method: string): string | undefined {
  switch (code) {
    case "invalid_auth":
    case "not_authed":
      return withRunNote(
        "Your session credentials look stale. Run: slacker auth refresh (then slacker auth setup if it still fails). " +
          "Slack desktop must be signed in; macOS may show a Keychain prompt."
      );
    case "token_revoked":
    case "token_expired":
    case "account_inactive":
      return withRunNote("This Slack session was signed out. Sign in to the Slack desktop app, then run: slacker auth setup");
    case "ratelimited":
      return POST_METHODS.has(method)
        ? `Slack is rate limiting this session${NOT_SENT}`
        : "Slack is rate limiting this session; wait a minute and try again.";
    case "missing_scope":
      return "This method isn't available to your user session in this workspace.";
    case "channel_not_found":
      return "Check the channel name/ID, and that you're a member of private channels.";
    default:
      return undefined;
  }
}

/** `1500` → "2s", `20` → "20ms" (a sub-second timeout shouldn't read as "0s"). */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${Math.round(ms / 1000)}s`;
}

export interface AuthTestResponse {
  team: string;
  user: string;
  team_id: string;
  user_id: string;
  url: string;
  enterprise_id?: string;
}

type Params = Record<string, string | number | boolean | undefined>;

export interface SlackAPIOptions {
  /** Per-request timeout (default 30s). */
  timeoutMs?: number;
  /** Retries for 429 / ratelimited / transient network errors / 5xx on reads (default 3). */
  maxRetries?: number;
  /** Overall budget for one call across all attempts and waits (default 90s). */
  deadlineMs?: number;
  /** Injectable for tests. Should resolve early (or reject) when `signal` aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CallOptions {
  /** Aborts the in-flight request and any pending retry wait. */
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_DEADLINE_MS = 90_000;
const MAX_WAIT_MS = 60_000;
/** Total rate-limit waiting allowed for a post before giving up (the caller is usually waiting live). */
const POST_RATE_LIMIT_BUDGET_MS = 10_000;
const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
/** Errors that mean the request never reached Slack, so even a non-idempotent call is safe to retry. */
const NOT_SENT_CODES = new Set(["EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
const jitter = () => Math.floor(Math.random() * 250);
const backoff = (attempt: number) => Math.min(500 * 2 ** attempt, 8000) + jitter();

/** Retry-After is either delta-seconds or an HTTP-date; anything unparseable waits 1s. */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  const value = header?.trim() ?? "";
  let ms = 1000;
  if (/^\d+(\.\d+)?$/.test(value)) ms = Number(value) * 1000;
  else if (/[a-z]/i.test(value)) {
    const date = Date.parse(value);
    if (Number.isFinite(date)) ms = Math.max(0, date - now);
  }
  return Math.min(ms, MAX_WAIT_MS);
}

/** Find a Node/undici error code anywhere in the cause chain. */
function errorCode(e: unknown): string | undefined {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  return name === "TimeoutError" || errorCode(e) === "UND_ERR_HEADERS_TIMEOUT" || errorCode(e) === "UND_ERR_BODY_TIMEOUT";
}

/** Did the request possibly reach Slack? (Only connect-level failures prove it didn't.) */
function isAmbiguous(e: unknown): boolean {
  const code = errorCode(e);
  return !(code && NOT_SENT_CODES.has(code));
}

function describeNetworkError(method: string, e: unknown, timeoutMs: number): SlackNetworkError {
  const suffix = POST_METHODS.has(method) && isAmbiguous(e) ? MAYBE_SENT : "";
  if (isTimeout(e)) {
    return new SlackNetworkError(method, `Network error calling ${method}: timed out after ${formatDuration(timeoutMs)}${suffix}`, e);
  }
  const code = errorCode(e);
  const cause = (e as { cause?: { message?: unknown } })?.cause;
  const detail = code ?? (typeof cause?.message === "string" ? cause.message : e instanceof Error ? e.message : String(e));
  return new SlackNetworkError(method, `Network error calling ${method}: ${detail}${suffix}`, e);
}

/** `inFlight`: the abort interrupted a request (which may have reached Slack), not a wait between attempts. */
function abortedError(method: string, signal: AbortSignal, inFlight: boolean): SlackNetworkError {
  const suffix = POST_METHODS.has(method) ? (inFlight ? MAYBE_SENT : NOT_SENT) : "";
  return new SlackNetworkError(method, `Network error calling ${method}: aborted${suffix}`, signal.reason);
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // body already consumed or stream errored — nothing to free
  }
}

/** Per-call retry bookkeeping. */
interface Budget {
  /** Time spent in fetches plus time spent (or scheduled) waiting. */
  spent: number;
  /** Rate-limit waiting so far. */
  rateLimitWaited: number;
}

/**
 * Minimal Slack Web API client authenticated as a user session (xoxc token + xoxd `d` cookie).
 * Everything you do through it appears as you.
 */
export class SlackAPI {
  private baseUrl = "https://slack.com/api";
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly deadlineMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(
    private readonly token: string,
    private readonly cookie: string,
    opts: SlackAPIOptions = {}
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  async call<T = unknown>(method: string, params: Params = {}, opts: CallOptions = {}): Promise<T> {
    const { signal } = opts;
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) body.set(k, String(v));
    }
    const budget: Budget = { spent: 0, rateLimitWaited: 0 };
    let ambiguousRetry = false; // a previous attempt may have reached Slack

    for (let attempt = 0; ; attempt++) {
      if (signal?.aborted) throw abortedError(method, signal, false);
      const canRetry = attempt < this.maxRetries;
      const remaining = this.deadlineMs - budget.spent;
      const attemptTimeout = Math.min(this.timeoutMs, remaining);
      if (attemptTimeout <= 0) {
        throw new SlackNetworkError(method, `Network error calling ${method}: timed out (gave up after ${formatDuration(this.deadlineMs)} including retries)`);
      }

      let res: Response;
      let text: string;
      const started = Date.now();
      try {
        const timeout = AbortSignal.timeout(attemptTimeout);
        res = await fetch(`${this.baseUrl}/${method}`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.token}`,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            Cookie: `d=${this.cookie}`,
          },
          body,
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (res.status === 429) {
          await drain(res);
          budget.spent += Date.now() - started;
          await this.rateLimitWait(method, res, canRetry, budget, signal, { status: 429 });
          continue;
        }
        text = await res.text();
      } catch (e) {
        if (e instanceof SlackApiError || e instanceof SlackNetworkError) throw e;
        if (signal?.aborted) throw abortedError(method, signal, true);
        budget.spent += Date.now() - started;
        if (canRetry && this.isRetryableNetworkError(method, e)) {
          const wait = backoff(attempt);
          if (budget.spent + wait < this.deadlineMs) {
            ambiguousRetry ||= isAmbiguous(e);
            await this.wait(wait, budget, method, signal);
            continue;
          }
        }
        throw describeNetworkError(method, e, attemptTimeout);
      }
      budget.spent += Date.now() - started;

      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        if (res.status >= 500 && canRetry && !isWriteMethod(method)) {
          const wait = backoff(attempt);
          if (budget.spent + wait < this.deadlineMs) {
            await this.wait(wait, budget, method, signal);
            continue;
          }
        }
        throw new SlackerError(
          `Slack API ${method} returned HTTP ${res.status} with a non-JSON response` +
            (res.status >= 500
              ? POST_METHODS.has(method)
                ? ` — Slack may be having problems;${MAYBE_SENT.slice(2)}`
                : " — Slack may be having problems; try again shortly."
              : "."),
          "http_error"
        );
      }
      if (!isPlainObject(json)) {
        throw new SlackerError(`Slack API ${method} returned HTTP ${res.status} with an unexpected response (not a JSON object).`, "http_error");
      }
      if (json.ok === true) return json as T;

      const code = typeof json.error === "string" ? json.error : `http_${res.status}`;
      if (code === "ratelimited") {
        await this.rateLimitWait(method, res, canRetry, budget, signal, json);
        continue;
      }
      // The earlier attempt deleted it before its response got lost.
      if (method === "chat.delete" && code === "message_not_found" && ambiguousRetry) {
        return { ok: true, retried: true } as T;
      }
      throw new SlackApiError(method, code, json);
    }
  }

  authTest(): Promise<AuthTestResponse> {
    return this.call<AuthTestResponse>("auth.test");
  }

  /** Wait out a rate limit, or throw `ratelimited` when retries, the post budget or the deadline run out. */
  private async rateLimitWait(method: string, res: Response, canRetry: boolean, budget: Budget, signal: AbortSignal | undefined, response: unknown) {
    const wait = retryAfterMs(res.headers.get("retry-after")) + jitter();
    const overPostBudget = POST_METHODS.has(method) && budget.rateLimitWaited + wait > POST_RATE_LIMIT_BUDGET_MS;
    if (!canRetry || overPostBudget || budget.spent + wait >= this.deadlineMs) {
      throw new SlackApiError(method, "ratelimited", response);
    }
    budget.rateLimitWaited += wait;
    await this.wait(wait, budget, method, signal);
  }

  /** Sleep that counts against the call's deadline and stops early when `signal` aborts. */
  private async wait(ms: number, budget: Budget, method: string, signal: AbortSignal | undefined): Promise<void> {
    budget.spent += ms;
    if (!signal) return this.sleep(ms);
    if (signal.aborted) throw abortedError(method, signal, false);
    let onAbort!: () => void;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.sleep(ms, signal), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (signal.aborted) throw abortedError(method, signal, false);
  }

  private isRetryableNetworkError(method: string, e: unknown): boolean {
    const code = errorCode(e);
    if (POST_METHODS.has(method)) return !isAmbiguous(e);
    return isTimeout(e) || (!!code && TRANSIENT_CODES.has(code));
  }
}
