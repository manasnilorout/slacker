import { isAuthError, SlackAPI, SlackApiError } from "./api.js";
import { SlackerError } from "./errors.js";
import { rawMessageText } from "./format.js";
import { createLimiter, Limiter } from "./limit.js";

export interface SlackUserSummary {
  id: string;
  username?: string;
  realName?: string;
  displayName?: string;
  title?: string;
  email?: string;
}

export interface SlackLink {
  host: string;
  channel: string;
  /** Message ts; absent for links to a whole channel. */
  ts?: string;
  threadTs?: string;
  /** Team (T…) or org (E…) ID from an app.slack.com/client link. */
  teamId?: string;
}

export type ConversationType = "channel" | "private_channel" | "dm" | "group_dm";

export interface ConversationSummary {
  id: string;
  type: ConversationType;
  /** `#name` for channels, `@display (Real Name)` for DMs, member list / name for group DMs. */
  name: string;
  /** For DMs: the other person's user ID. */
  userId?: string;
  /** Set when Slack reports the conversation as archived. */
  archived?: true;
}

/** Where a write goes. `id` is null only for a dry run to a person whose DM isn't opened yet. */
export type Destination = Omit<ConversationSummary, "id"> & { id: string | null };

/** A target string classified without any network calls. */
export type TargetSpec =
  | { kind: "conversation"; id: string }
  | { kind: "link"; link: SlackLink }
  | { kind: "user"; query: string }
  | { kind: "channel"; name: string; bare: boolean };

// Real Slack IDs always contain a digit; this keeps words like GENERAL or WEBTEAM out.
export const CONVERSATION_ID = /^[CDG](?=[A-Z0-9]*\d)[A-Z0-9]{8,}$/;
export const USER_ID = /^[UW](?=[A-Z0-9]*\d)[A-Z0-9]{8,}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BROADCASTS = new Set(["here", "channel", "everyone"]);

/** search.modules page size for person resolution; a full page may hide more exact matches. */
const PEOPLE_SEARCH_COUNT = 50;
/** A miss against a joined-channels scan older than this triggers one rescan (new/renamed channels). */
const STALE_SCAN_MS = 60_000;

/** Codes meaning "this lookup isn't available to this session" — safe to skip and try another source. */
const UNAVAILABLE_CODES = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "method_not_supported_for_channel_type",
  "unknown_method",
  "restricted_action",
  "enterprise_is_restricted",
  "team_access_not_granted",
]);

export function isUnavailable(e: unknown): boolean {
  return e instanceof SlackApiError && UNAVAILABLE_CODES.has(e.code);
}

function hasCode(e: unknown, ...codes: string[]): boolean {
  return e instanceof SlackApiError && codes.includes(e.code);
}

/** Normalize a Slack ts with a fraction: `1700000000.1` → `1700000000.100000`. */
function normalizeTs(ts: string): string {
  const [secs, frac = ""] = ts.split(".");
  return `${secs}.${frac.padEnd(6, "0")}`;
}

const ID_PART = "[CDG][A-Z0-9]{8,}";
const ARCHIVES_PATH = new RegExp(`^/archives/(${ID_PART})(?:/p(\\d{10})(\\d{6}))?/?$`);
const CLIENT_PATH = new RegExp(
  `^/client/([TE][A-Z0-9]{8,})/(${ID_PART})(?:/p(\\d{10})(\\d{6})|/thread/(${ID_PART})-(\\d{10}\\.\\d{6}))?/?$`
);

/**
 * Parse a Slack link:
 * - `https://<team>.slack.com/archives/<C…>` (whole channel) or `…/archives/<C…>/p<16 digits>[?thread_ts=<ts>]`
 * - `https://app.slack.com/client/<T…>/<C…>[/p<16 digits> | /thread/<C…>-<ts>]`
 * Only slack.com hosts are accepted. A `thread_ts` without a fraction is ignored (not a real ts).
 */
export function parseSlackLink(link: string): SlackLink | null {
  let s = link.trim();
  // Slack-formatted links: <https://…|label>
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).split("|")[0];
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "slack.com" && !host.endsWith(".slack.com")) return null;

  const rawThread = url.searchParams.get("thread_ts");
  const queryThread = rawThread && /^\d{10}\.\d{1,6}$/.test(rawThread) ? normalizeTs(rawThread) : undefined;

  const a = url.pathname.match(ARCHIVES_PATH);
  if (a) return { host, channel: a[1], ts: a[2] ? `${a[2]}.${a[3]}` : undefined, threadTs: queryThread };

  const c = url.pathname.match(CLIENT_PATH);
  if (!c) return null;
  const [, teamId, channel, secs, frac, threadChannel, threadTs] = c;
  if (threadChannel) {
    if (threadChannel !== channel) return null;
    return { host, channel, ts: threadTs, threadTs, teamId };
  }
  return { host, channel, ts: secs ? `${secs}.${frac}` : undefined, threadTs: queryThread, teamId };
}

/**
 * Classify a target without network calls: conversation ID (also `#C0123ABCD` and Slack's
 * `<#C0123ABCD|name>`), Slack link, person (`@handle`, user ID, email), or channel name.
 */
export function parseTarget(target: string): TargetSpec {
  const t = target.trim();
  if (!t) throw new SlackerError("No target given. Pass a #channel, @person, conversation ID, or Slack link.", "invalid_target");
  if (CONVERSATION_ID.test(t)) return { kind: "conversation", id: t };

  const mention = t.match(/^<#([A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (mention && CONVERSATION_ID.test(mention[1])) return { kind: "conversation", id: mention[1] };
  if (t.startsWith("#") && CONVERSATION_ID.test(t.slice(1))) return { kind: "conversation", id: t.slice(1) };

  const link = parseSlackLink(t);
  if (link) return { kind: "link", link };
  if (/^<?https?:\/\//i.test(t)) {
    throw new SlackerError(
      `"${t}" is not a Slack message or channel link. Expected https://<team>.slack.com/archives/<channel ID>[/p<ts>] ` +
        "or https://app.slack.com/client/<team ID>/<channel ID>.",
      "invalid_target"
    );
  }

  if (t.startsWith("@") || USER_ID.test(t) || EMAIL.test(t)) return { kind: "user", query: t };
  const name = t.replace(/^#/, "").trim().toLowerCase();
  if (!name) throw new SlackerError("No channel name given.", "invalid_target");
  return { kind: "channel", name, bare: !t.startsWith("#") };
}

// ── Minimal Slack response shapes ───────────────────────

interface Paged {
  response_metadata?: { next_cursor?: string };
}

export interface SlackUser {
  id: string;
  name?: string;
  username?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: {
    display_name?: string;
    display_name_normalized?: string;
    real_name?: string;
    real_name_normalized?: string;
    title?: string;
    email?: string;
  };
}

export interface SlackChannel {
  id: string;
  name?: string;
  user?: string;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_group?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

interface ChannelsPage extends Paged {
  channels?: SlackChannel[];
}

interface MembersPage extends Paged {
  members?: SlackUser[];
}

function toSummary(u: SlackUser): SlackUserSummary {
  const p = u.profile ?? {};
  return {
    id: u.id,
    username: u.name ?? u.username,
    realName: u.real_name || p.real_name || undefined,
    displayName: p.display_name || undefined,
    title: p.title || undefined,
    email: p.email || undefined,
  };
}

function displayName(u: SlackUser): string {
  return u.profile?.display_name || u.real_name || u.profile?.real_name || u.name || u.id;
}

/** `@display (Real Name)` — how DM destinations are shown. */
function dmName(u: SlackUser): string {
  const real = u.real_name || u.profile?.real_name;
  const handle = displayName(u);
  return real && real !== handle ? `@${handle} (${real})` : `@${handle}`;
}

/** Lowercased handle / display name / real name keys a person can be matched on exactly. */
function exactKeys(u: SlackUser): Set<string> {
  const p = u.profile ?? {};
  const keys = new Set<string>();
  for (const f of [u.name, u.username, u.real_name, p.display_name, p.display_name_normalized, p.real_name, p.real_name_normalized]) {
    const k = typeof f === "string" ? f.trim().toLowerCase() : "";
    if (k) keys.add(k);
  }
  return keys;
}

function isSubstringMatch(u: SlackUser, needle: string): boolean {
  const p = u.profile ?? {};
  return [u.name, u.real_name, p.display_name, p.real_name, p.email].some(
    (f) => typeof f === "string" && f.toLowerCase().includes(needle)
  );
}

function describeCandidates(users: SlackUser[]): string {
  return users
    .slice(0, 5)
    .map((u) => `${u.real_name || u.profile?.real_name || u.name} (@${u.name ?? u.username ?? "?"}, ${u.id})`)
    .join("; ");
}

const FIND_CHANNEL_HINT = "Look it up with `slacker channels --all --filter <text>` / list_channels.";
const FIND_USER_HINT = "Look it up with `slacker users <name>` / find_user.";
const USE_USER_ID = "Use the user ID (find it with `slacker users <name>` / find_user).";

export interface ResolverOptions {
  /** Workspace name used in error messages. */
  workspace?: string;
  /** How long the channel directory and user caches stay fresh. Default 10 minutes. */
  ttlMs?: number;
  /** Max pages scanned per directory source (users.conversations, conversations.list, users.list). */
  maxPages?: number;
  /** Max concurrent Slack calls made for name decoration (users.info / conversations.info). */
  concurrency?: number;
  now?: () => number;
}

interface DirectorySource {
  method: "users.conversations" | "conversations.list";
  params: Record<string, string | number>;
  cursor?: string;
  pages: number;
  /** Fully scanned (or unavailable to this session). */
  done: boolean;
  /** When a full scan finished (unset when the source was skipped as unavailable). */
  completedAt?: number;
}

interface Directory {
  byName: Map<string, string>;
  sources: DirectorySource[];
  expires: number;
}

/** users.list fallback directory (used when search.modules isn't available). */
interface PeopleDirectory {
  byKey: Map<string, SlackUser[]>;
  all: SlackUser[];
  cursor?: string;
  pages: number;
  done: boolean;
  expires: number;
}

interface PeopleResult {
  candidates: SlackUser[];
  exact: SlackUser[];
  /** More people may match than were seen (full search page, or a page-capped directory). */
  truncated: boolean;
  source: "search" | "directory";
}

/**
 * Per-workspace resolver with in-memory caches. One instance lives for the lifetime of the MCP
 * server (per credentials), so repeated lookups of the same channel or person are cheap.
 */
export class Resolver {
  private readonly ttlMs: number;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly limit: Limiter;
  private readonly workspaceLabel: string;

  private directory?: Directory;
  private people?: PeopleDirectory;
  /** search.modules answered with an "unavailable" code; don't ask again. */
  private peopleSearchUnavailable = false;
  private queues: Record<"channels" | "people", Promise<unknown>> = { channels: Promise.resolve(), people: Promise.resolve() };
  private users = new Map<string, { value: Promise<SlackUser>; expires: number }>();
  private conversations = new Map<string, { value: Promise<SlackChannel>; expires: number }>();
  private dmChannels = new Map<string, string>();

  constructor(
    private readonly api: SlackAPI,
    opts: ResolverOptions = {}
  ) {
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.maxPages = opts.maxPages ?? 20;
    this.now = opts.now ?? Date.now;
    this.limit = createLimiter(opts.concurrency ?? 6);
    this.workspaceLabel = opts.workspace ? `workspace "${opts.workspace}"` : "this workspace";
  }

  // ── People ───────────────────────────────────────────

  /** Find people by name, handle or email (for listings — may include partial matches). */
  async findUsers(query: string, limit = 10): Promise<SlackUserSummary[]> {
    const q = query.trim().replace(/^@/, "").trim();
    if (!q) return [];
    if (USER_ID.test(q)) {
      try {
        return [toSummary(await this.user(q))];
      } catch (e) {
        if (hasCode(e, "user_not_found")) return [];
        throw e;
      }
    }
    if (EMAIL.test(q)) {
      const u = await this.lookupByEmail(q);
      return u ? [toSummary(u)] : [];
    }
    const { candidates } = (await this.searchPeople(q, limit))!;
    return candidates.slice(0, limit).map(toSummary);
  }

  /** One users.list page of active, non-bot people (`limit` is the page size asked of Slack). */
  async listUsers(limit = 100, cursor?: string): Promise<{ users: SlackUserSummary[]; nextCursor: string | null }> {
    const page = await this.api.call<MembersPage>("users.list", { limit, cursor });
    const users = (page.members ?? [])
      .filter((u) => !u.deleted && !u.is_bot && u.id !== "USLACKBOT")
      .map(toSummary);
    return { users, nextCursor: page.response_metadata?.next_cursor || null };
  }

  /**
   * Resolve "@handle", "Full Name", email or user ID to exactly one user ID. Only exact matches
   * on handle, display name or real name are accepted — never a lone fuzzy hit, and never a lone
   * exact hit from results that may be incomplete.
   */
  async resolveUserId(target: string): Promise<string> {
    const q = target.trim().replace(/^@/, "").trim();
    if (!q) throw new SlackerError("No user given. Pass a user ID, @handle, exact name, or email.", "invalid_target");
    if (BROADCASTS.has(q.toLowerCase())) {
      throw new SlackerError(
        `"@${q.toLowerCase()}" is a broadcast mention, not a person. Name a channel or a specific person.`,
        "invalid_target"
      );
    }
    if (USER_ID.test(q)) return q;
    if (EMAIL.test(q)) {
      const u = await this.lookupByEmail(q);
      if (!u) throw new SlackerError(`No Slack user in ${this.workspaceLabel} has the email ${q}. ${FIND_USER_HINT}`, "user_not_found");
      return u.id;
    }

    const { candidates, exact, truncated, source } = (await this.searchPeople(q, PEOPLE_SEARCH_COUNT))!;
    if (exact.length > 1) {
      throw new SlackerError(
        `"${target}" matches ${exact.length} people exactly: ${describeCandidates(exact)}. Retry with the user ID.`,
        "ambiguous_user"
      );
    }
    if (exact.length === 1 && !truncated) return exact[0].id;
    if (exact.length === 1) {
      const [code, why] =
        source === "directory"
          ? (["directory_too_large", `the user directory of ${this.workspaceLabel} is too large to scan fully`] as const)
          : (["ambiguous_user", `people search returned a full page of ${PEOPLE_SEARCH_COUNT} results`] as const);
      throw new SlackerError(
        `"${target}" exactly matches ${describeCandidates(exact)}, but ${why}, so someone else may have the same name. ${USE_USER_ID}`,
        code,
        USE_USER_ID
      );
    }
    if (candidates.length) {
      throw new SlackerError(
        `No one in ${this.workspaceLabel} is exactly "${q}". Close matches: ${describeCandidates(candidates)}. ` +
          `Retry with the user ID or exact @handle.`,
        "user_not_found"
      );
    }
    if (truncated && source === "directory") {
      throw new SlackerError(
        `No Slack user matches "${target}" in ${this.workspaceLabel}, but the user directory is too large to scan fully. ` +
          "Use the user ID or email.",
        "directory_too_large"
      );
    }
    throw new SlackerError(`No Slack user matches "${target}" in ${this.workspaceLabel}. ${FIND_USER_HINT}`, "user_not_found");
  }

  private async lookupByEmail(email: string): Promise<SlackUser | null> {
    try {
      const res = await this.api.call<{ user: SlackUser }>("users.lookupByEmail", { email });
      return res.user;
    } catch (e) {
      if (hasCode(e, "users_not_found", "user_not_found")) return null;
      throw e;
    }
  }

  /**
   * People search via the web client's search.modules, falling back to the cached, page-capped
   * users.list directory when that method isn't available (returns null instead with
   * `fallback: false`). `exact` holds the verified exact matches.
   */
  private async searchPeople(q: string, count: number, { fallback = true } = {}): Promise<PeopleResult | null> {
    const needle = q.toLowerCase();
    if (!this.peopleSearchUnavailable) {
      try {
        const res = await this.api.call<{ items?: SlackUser[] }>("search.modules", { module: "people", query: q, count });
        const items = res.items ?? [];
        const candidates = items.filter((u) => u?.id && !u.deleted);
        return {
          candidates,
          exact: candidates.filter((u) => exactKeys(u).has(needle)),
          truncated: items.length >= count,
          source: "search",
        };
      } catch (e) {
        if (!isUnavailable(e)) throw e;
        this.peopleSearchUnavailable = true;
      }
    }
    if (!fallback) return null;

    const dir = await this.scanPeople();
    const exact = dir.byKey.get(needle) ?? [];
    const fuzzy: SlackUser[] = [];
    for (const u of dir.all) {
      if (fuzzy.length >= count) break;
      if (!exact.includes(u) && isSubstringMatch(u, needle)) fuzzy.push(u);
    }
    return { candidates: [...exact, ...fuzzy], exact, truncated: !dir.done, source: "directory" };
  }

  /** Scan users.list (page-capped, resumable after a failure, cached for the TTL). */
  private scanPeople(): Promise<PeopleDirectory> {
    return this.serial("people", async () => {
      if (!this.people || this.people.expires <= this.now()) {
        this.people = { byKey: new Map(), all: [], pages: 0, done: false, expires: this.now() + this.ttlMs };
      }
      const dir = this.people;
      while (!dir.done && dir.pages < this.maxPages) {
        const page = await this.api.call<MembersPage>("users.list", { limit: 200, cursor: dir.cursor });
        dir.pages++;
        for (const u of page.members ?? []) {
          if (!u?.id || u.deleted) continue;
          dir.all.push(u);
          for (const key of exactKeys(u)) dir.byKey.set(key, [...(dir.byKey.get(key) ?? []), u]);
        }
        dir.cursor = page.response_metadata?.next_cursor || undefined;
        if (!dir.cursor) dir.done = true;
      }
      return dir;
    });
  }

  /** users.info, cached as a promise (in-flight lookups are shared); failures are not cached. */
  user(id: string): Promise<SlackUser> {
    return this.cached(this.users, id, () =>
      this.limit(() => this.api.call<{ user: SlackUser }>("users.info", { user: id })).then((r) => r.user)
    );
  }

  /** Display name for a user ID; falls back to the raw ID (uncached) unless the session is unauthenticated. */
  async userName(id: string): Promise<string> {
    try {
      return displayName(await this.user(id));
    } catch (e) {
      if (isAuthError(e)) throw e;
      return id;
    }
  }

  /** Resolve every user referenced by a batch of messages (authors and <@mentions>). */
  async userMap(messages: Array<{ user?: string; text?: string }>): Promise<Record<string, string>> {
    const ids = new Set<string>();
    for (const m of messages) {
      if (m.user) ids.add(m.user);
      for (const match of rawMessageText(m).matchAll(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g)) ids.add(match[1]);
    }
    const entries = await Promise.all([...ids].map(async (id) => [id, await this.userName(id)] as const));
    return Object.fromEntries(entries);
  }

  /**
   * The DM destination for a person without opening the DM (dry runs). users.info must succeed,
   * so a mistyped user ID fails here instead of looking fine.
   */
  async describeUserDM(userId: string): Promise<Destination> {
    let u: SlackUser;
    try {
      u = await this.user(userId);
    } catch (e) {
      if (hasCode(e, "user_not_found", "users_not_found")) {
        throw new SlackerError(`No Slack user ${userId} in ${this.workspaceLabel}. ${FIND_USER_HINT}`, "user_not_found");
      }
      throw e;
    }
    return { id: null, type: "dm", name: dmName(u), userId };
  }

  // ── Conversations ────────────────────────────────────

  /** conversations.info, cached like `user()`. */
  conversationInfo(id: string): Promise<SlackChannel> {
    return this.cached(this.conversations, id, () =>
      this.limit(() => this.api.call<{ channel: SlackChannel }>("conversations.info", { channel: id })).then((r) => r.channel)
    );
  }

  /**
   * Human description of a conversation; degrades to the ID when Slack won't say. Auth errors
   * always throw; with `strict` (used before writes) anything but a D1 "unavailable" code throws,
   * so e.g. a dry run against a bad channel ID fails instead of looking fine. `fresh` skips the
   * cached conversations.info (used to verify a name-based write target).
   */
  async describeConversation(
    id: string,
    { strict = false, fresh = false }: { strict?: boolean; fresh?: boolean } = {}
  ): Promise<ConversationSummary> {
    if (fresh) this.conversations.delete(id);
    let ch: SlackChannel;
    try {
      ch = await this.conversationInfo(id);
    } catch (e) {
      if (isAuthError(e) || (strict && !isUnavailable(e))) throw e;
      const type: ConversationType = id.startsWith("D") ? "dm" : id.startsWith("G") ? "private_channel" : "channel";
      return { id, type, name: id };
    }
    const archived = ch.is_archived ? { archived: true as const } : {};
    if (ch.is_im && ch.user) {
      let name = `@${ch.user}`;
      try {
        name = dmName(await this.user(ch.user));
      } catch (e) {
        if (isAuthError(e)) throw e;
      }
      return { id, type: "dm", name, userId: ch.user, ...archived };
    }
    if (ch.is_mpim) return { id, type: "group_dm", name: ch.purpose?.value || ch.name || id, ...archived };
    return {
      id,
      type: ch.is_private || ch.is_group ? "private_channel" : "channel",
      name: ch.name ? `#${ch.name}` : id,
      ...archived,
    };
  }

  async openDM(userIds: string | string[]): Promise<string> {
    const key = ([] as string[]).concat(userIds).sort().join(",");
    const cached = this.dmChannels.get(key);
    if (cached) return cached;
    const dm = await this.api.call<{ channel: { id: string } }>("conversations.open", { users: key });
    this.dmChannels.set(key, dm.channel.id);
    return dm.channel.id;
  }

  /**
   * Resolve a target to a conversation ID. Accepts a conversation ID, a Slack link,
   * "#channel"/"channel" names (channels only — never people), or "@person" / user ID / email
   * (opens a DM). `forWrite` is accepted for API symmetry; reads and writes resolve identically.
   */
  async resolveConversation(target: string, _opts: { forWrite?: boolean } = {}): Promise<string> {
    return this.resolveSpec(parseTarget(target));
  }

  /** `resolveConversation` for an already-parsed target. */
  async resolveSpec(spec: TargetSpec): Promise<string> {
    switch (spec.kind) {
      case "conversation":
        return spec.id;
      case "link":
        return spec.link.channel;
      case "user":
        return this.openDM(await this.resolveUserId(spec.query));
      case "channel":
        return this.channelId(spec.name, { bare: spec.bare });
    }
  }

  /** Look up a channel by name in the cached, page-capped channel directory. */
  async channelId(target: string, { bare = !target.startsWith("#") }: { bare?: boolean } = {}): Promise<string> {
    const name = target.replace(/^#/, "").trim().toLowerCase();
    if (!name) throw new SlackerError("No channel name given.", "invalid_target");

    const { id, truncated } = await this.scanDirectory(name);
    if (id) return id;

    const suggestion = bare && !/\s/.test(name) ? await this.personSuggestion(name) : "";
    if (truncated) {
      throw new SlackerError(
        `No channel named "#${name}" found in ${this.workspaceLabel}: the channel directory is too large to search ` +
          `by name. ${suggestion}Use the channel ID (e.g. C0123ABCD) or a link to the channel instead.`,
        "directory_too_large"
      );
    }
    throw new SlackerError(
      `No channel named "#${name}" in ${this.workspaceLabel} (it may be archived, or private and you're not a member). ` +
        `${suggestion}${FIND_CHANNEL_HINT}`,
      "channel_not_found"
    );
  }

  /**
   * Forget what the directory knows (e.g. a name turned out to point at a renamed channel) so
   * the next lookup rescans. Also drops the cached conversations.info for `id`.
   */
  invalidateChannel(id?: string): void {
    this.directory = undefined;
    if (id) this.conversations.delete(id);
  }

  /** `Did you mean "@x"?` for a bare channel name that is exactly one person — best effort only. */
  private async personSuggestion(name: string): Promise<string> {
    try {
      const r = await this.searchPeople(name, PEOPLE_SEARCH_COUNT, { fallback: false });
      if (r && r.exact.length === 1 && !r.truncated) return `Did you mean "@${r.exact[0].name ?? name}" (a person)? `;
    } catch {
      // A failed suggestion must never replace the real "no such channel" error.
    }
    return "";
  }

  private freshDirectory(): Directory {
    if (!this.directory || this.directory.expires <= this.now()) {
      this.directory = {
        byName: new Map(),
        expires: this.now() + this.ttlMs,
        sources: [
          // Channels you're in (incl. private) first: small and fast. Then the public directory.
          {
            method: "users.conversations",
            params: { types: "public_channel,private_channel", exclude_archived: "true", limit: 200 },
            pages: 0,
            done: false,
          },
          {
            method: "conversations.list",
            params: { types: "public_channel", exclude_archived: "true", limit: 1000 },
            pages: 0,
            done: false,
          },
        ],
      };
    }
    return this.directory;
  }

  /** Fetch pages of `src` until `name` turns up or the source is exhausted/capped. */
  private async scanSource(dir: Directory, src: DirectorySource, name: string, overwrite = false): Promise<string | undefined> {
    while (!src.done && src.pages < this.maxPages) {
      let page: ChannelsPage;
      try {
        page = await this.api.call<ChannelsPage>(src.method, { ...src.params, cursor: src.cursor });
      } catch (e) {
        if (!isUnavailable(e)) throw e;
        src.done = true; // e.g. conversations.list restricted on Enterprise Grid
        break;
      }
      src.pages++;
      for (const ch of page.channels ?? []) {
        const key = ch.name?.toLowerCase();
        if (key && (overwrite || !dir.byName.has(key))) dir.byName.set(key, ch.id);
      }
      src.cursor = page.response_metadata?.next_cursor || undefined;
      if (!src.cursor) {
        src.done = true;
        src.completedAt = this.now();
      }
      const found = dir.byName.get(name);
      if (found) return found;
    }
    return dir.byName.get(name);
  }

  /**
   * Scan directory sources page by page until `name` turns up. Progress is kept for the TTL, so
   * later lookups resume where the last stopped. A miss after a complete joined-channels scan
   * older than a minute rescans that source once (you may have just created or joined it).
   * Scans are serialized so concurrent lookups don't fetch the same pages twice.
   */
  private scanDirectory(name: string): Promise<{ id?: string; truncated: boolean }> {
    return this.serial("channels", async () => {
      const dir = this.freshDirectory();
      for (const src of dir.sources) {
        const hit = dir.byName.get(name) ?? (await this.scanSource(dir, src, name));
        if (hit) return { id: hit, truncated: false };
      }
      const joined = dir.sources[0];
      if (joined.completedAt !== undefined && this.now() - joined.completedAt > STALE_SCAN_MS) {
        Object.assign(joined, { cursor: undefined, pages: 0, done: false, completedAt: undefined });
        const hit = await this.scanSource(dir, joined, name, true);
        if (hit) return { id: hit, truncated: false };
      }
      return { truncated: dir.sources.some((s) => !s.done) };
    });
  }

  /** Run `task` after every earlier task in the same queue has settled. */
  private serial<T>(queue: "channels" | "people", task: () => Promise<T>): Promise<T> {
    const result = this.queues[queue].then(task, task);
    this.queues[queue] = result.catch(() => undefined);
    return result;
  }

  private cached<T>(map: Map<string, { value: Promise<T>; expires: number }>, key: string, load: () => Promise<T>): Promise<T> {
    const hit = map.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = load();
    const entry = { value, expires: this.now() + this.ttlMs };
    map.set(key, entry);
    value.catch(() => {
      if (map.get(key) === entry) map.delete(key);
    });
    return value;
  }
}
