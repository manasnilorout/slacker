import { SlackAPI, SlackAPIOptions, SlackApiError, AuthTestResponse } from "./api.js";
import { withRunNote } from "./command.js";
import { resolveWorkspace, ResolvedWorkspace, teamAliases, WorkspaceSource } from "./config.js";
import { SlackerError } from "./errors.js";
import { aliasRefusal, mismatchRefusal, unverifiedRefusal } from "./messages.js";
import {
  Resolver,
  ResolverOptions,
  parseTarget,
  TargetSpec,
  SlackLink,
  SlackUserSummary,
  SlackChannel,
  Destination,
} from "./resolve.js";
import { formatMessage, resolveMentions, tsToIso, SlackMessage } from "./format.js";

export const HISTORY_LIMITED =
  "Slack reports this workspace's message history is limited (free plan): older messages are hidden, though search may still find them.";

/** Longest status expiry accepted: one year. */
export const MAX_STATUS_MINUTES = 525_600;

const SLACK_TS = /^\d{9,10}(\.\d{1,6})?$/;
const TIME_HELP =
  "Use YYYY-MM-DD (local midnight), an ISO date-time (2026-10-01T09:30, optional Z/±hh:mm), a Slack ts " +
  "(1700000000.123456), or relative: 30m, 2h, 7d, 1w, today, yesterday, now.";
const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

function validCalendarDate(y: number, m: number, d: number): boolean {
  const date = new Date(y, m - 1, d);
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
}

/**
 * Parse a time for Slack's oldest/latest. Accepts a Slack ts (9–10 digit seconds), `YYYY-MM-DD`
 * (local midnight), ISO date-times (no zone = local), relative `30m`/`2h`/`7d`/`1w`, and
 * `today`/`yesterday`/`now`. Anything else — including impossible dates — is rejected.
 */
export function toSlackTs(value: string | undefined, now: Date = new Date()): string | undefined {
  const v = value?.trim();
  if (!v) return undefined;
  if (SLACK_TS.test(v)) return v;

  const lower = v.toLowerCase();
  let ms: number | undefined;
  if (lower === "now") ms = now.getTime();
  else if (lower === "today" || lower === "yesterday") {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (lower === "yesterday") d.setDate(d.getDate() - 1);
    ms = d.getTime();
  } else {
    const rel = lower.match(/^(\d+)\s*(m|min|mins|h|hr|hrs|d|w)(?:\s+ago)?$/);
    const day = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/i);
    if (rel) ms = now.getTime() - Number(rel[1]) * UNIT_MS[rel[2][0]];
    else if (day) {
      const [y, m, d] = [Number(day[1]), Number(day[2]), Number(day[3])];
      if (validCalendarDate(y, m, d)) ms = new Date(y, m - 1, d).getTime();
    } else if (iso) {
      const [y, m, d, hh, mm, ss] = [1, 2, 3, 4, 5, 6].map((i) => Number(iso[i] ?? 0));
      if (validCalendarDate(y, m, d) && hh < 24 && mm < 60 && ss < 60) ms = Date.parse(v.replace(" ", "T"));
    }
  }
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    throw new SlackerError(`Could not parse time "${value}". ${TIME_HELP}`, "invalid_time");
  }
  return (ms / 1000).toFixed(6);
}

function checkTs(ts: string, what: string): string {
  const t = ts.trim();
  if (!/^\d{9,10}\.\d{6}$/.test(t)) {
    throw new SlackerError(
      `${what} "${ts}" is not a Slack message ts (e.g. 1700000000.123456). Pass the ts or a Slack message link.`,
      "invalid_ts"
    );
  }
  return t;
}

/** Message ts for edit/delete/react: explicit ts, else the link's message. */
function messageTs(link: SlackLink | null, ts: string | undefined): string {
  const resolved = ts ?? link?.ts;
  if (!resolved) throw new SlackerError("Provide the message ts (--ts / ts) or a Slack message link.", "missing_ts");
  return checkTs(resolved, "Message ts");
}

function requireText(text: string, message: string): void {
  if (!text.trim()) throw new SlackerError(message, "invalid_argument");
}

function linkOf(spec: TargetSpec): SlackLink | null {
  return spec.kind === "link" ? spec.link : null;
}

function hostOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Links on these hosts aren't tied to one workspace. */
const GENERIC_HOSTS = new Set(["slack.com", "app.slack.com"]);

interface Identity {
  team: string;
  teamId: string;
  user: string;
  userId: string;
  url: string;
  enterpriseId?: string;
}

/** One consistent view of config + credentials for the duration of a call. */
interface Client {
  api: SlackAPI;
  resolver: Resolver;
  ws: ResolvedWorkspace;
}

/** Options every write method accepts. */
export interface WriteOptions {
  /**
   * Write even though this workspace shares its team with another config entry, or config.json
   * has no teamId for it (CLI `--allow-alias`; MCP never sets this). A team mismatch is never bypassed.
   */
  allowAlias?: boolean;
  /** Aborts the Slack write call (e.g. the MCP request was cancelled). */
  signal?: AbortSignal;
}

/** Fields every write result carries so callers can show exactly where a write landed. */
export interface WriteContext {
  workspace: string;
  team: string;
  teamDomain: string | null;
  destination: Destination;
  /** Same as destination.id (kept for older callers); null for a dry run to a person. */
  channel: string | null;
}

export interface SendResult extends WriteContext {
  sent: boolean;
  dryRun?: true;
  threadTs: string | null;
  ts?: string;
  permalink?: string | null;
}

interface HistoryResponse {
  messages?: SlackMessage[];
  has_more?: boolean;
  is_limited?: boolean;
  response_metadata?: { next_cursor?: string };
}

interface SearchMatch {
  ts: string;
  user?: string;
  username?: string;
  text?: string;
  permalink?: string;
  channel?: { id?: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean; user?: string };
}

interface StatusProfile {
  display_name?: string;
  real_name?: string;
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
}

interface CountsEntry {
  id: string;
  has_unreads?: boolean;
  mention_count?: number;
  latest?: string;
}

export interface SlackSessionOptions {
  api?: SlackAPIOptions;
  resolver?: Omit<ResolverOptions, "workspace">;
  /** How the workspace name was chosen, named in "workspace not found" errors. */
  source?: { source: WorkspaceSource; projectFile?: string };
}

/** Pages users.list may fetch to fill one people listing. */
const MAX_LIST_PAGES = 5;

/**
 * Every Slack operation slacker supports, bound to one workspace. Both the MCP server and the
 * CLI call into this. The config file is re-read on every call so `slacker auth refresh` takes
 * effect without restarting a long-running MCP server.
 */
export class SlackSession {
  private current?: Client & { key: string };
  /** Live auth.test identity per API client (i.e. per credentials). */
  private identities = new WeakMap<SlackAPI, Promise<Identity>>();

  constructor(
    private readonly workspaceName: string | undefined,
    private readonly configFile: string,
    private readonly opts: SlackSessionOptions = {}
  ) {}

  workspace(): ResolvedWorkspace {
    return resolveWorkspace(this.workspaceName, this.configFile, this.opts.source);
  }

  client(): Client {
    const ws = this.workspace();
    const key = `${ws.name}\0${ws.token}\0${ws.cookie}`;
    if (!this.current || this.current.key !== key) {
      const api = new SlackAPI(ws.token, ws.cookie, this.opts.api);
      const resolver = new Resolver(api, { ...this.opts.resolver, workspace: ws.name });
      this.current = { api, resolver, ws, key };
    }
    return { api: this.current.api, resolver: this.current.resolver, ws };
  }

  /** Live auth.test identity, cached per credentials (failures are not cached). */
  private liveIdentity(api: SlackAPI): Promise<Identity> {
    let p = this.identities.get(api);
    if (!p) {
      const pending = api.authTest().then(
        (a: AuthTestResponse): Identity => ({
          team: a.team,
          teamId: a.team_id,
          user: a.user,
          userId: a.user_id,
          url: a.url,
          ...(a.enterprise_id && { enterpriseId: a.enterprise_id }),
        })
      );
      this.identities.set(api, pending);
      pending.catch(() => {
        if (this.identities.get(api) === pending) this.identities.delete(api);
      });
      p = pending;
    }
    return p;
  }

  async whoami() {
    const { api, ws } = this.client();
    const id = await this.liveIdentity(api);
    return {
      workspace: ws.name,
      team: id.team,
      teamId: id.teamId,
      user: id.user,
      userId: id.userId,
      url: id.url,
      ...(id.enterpriseId && { enterpriseId: id.enterpriseId }),
      aliases: teamAliases(ws.name, this.configFile),
    };
  }

  /**
   * Refuse to write unless config.json unambiguously names the team the credentials sign in to:
   * no other entry may share this teamId (unless `allowAlias`), the teamId must be recorded
   * (unless `allowAlias`), and it must equal the live team (never bypassed).
   */
  private async verifyWriteIdentity({ api, ws }: Client, allowAlias = false): Promise<Identity> {
    const aliases = teamAliases(ws.name, this.configFile);
    if (aliases.length && !allowAlias) {
      const team = await this.liveIdentity(api).then(
        (i) => i.team,
        () => ws.teamId
      );
      throw new SlackerError(
        aliasRefusal(ws.name, aliases, team),
        "workspace_alias",
        withRunNote("slacker auth list → slacker auth remove <copy> → slacker auth setup")
      );
    }
    if (!ws.teamId && !allowAlias) {
      throw new SlackerError(unverifiedRefusal(ws.name), "team_unverified", withRunNote("slacker auth setup"));
    }
    const id = await this.liveIdentity(api);
    if (ws.teamId && id.teamId !== ws.teamId) {
      throw new SlackerError(mismatchRefusal(ws.name, ws.teamId, id), "team_mismatch", withRunNote("slacker auth setup"));
    }
    return id;
  }

  /** A link must belong to this workspace, or the API answers with an opaque channel_not_found. */
  private async checkLinkHost(link: SlackLink, { api, ws }: Client): Promise<void> {
    const cfgHost = hostOf(ws.url);
    const switchHint =
      `Use the workspace the link belongs to (CLI: --workspace <name>; MCP: the slacker server for that workspace; ` +
      `list them with slacker auth list), or a link from this workspace.`;
    if (link.teamId) {
      // app.slack.com/client/<team>/… — the host says nothing, the team ID does.
      const id = await this.liveIdentity(api);
      if (link.teamId === id.teamId || id.enterpriseId) return;
      throw new SlackerError(
        withRunNote(`That link is for team ${link.teamId}, but workspace "${ws.name}" signs in to "${id.team}" (${id.teamId}). ${switchHint}`),
        "cross_workspace_link"
      );
    }
    if (GENERIC_HOSTS.has(link.host) || link.host === cfgHost) return;
    const id = await this.liveIdentity(api);
    // Enterprise Grid: one session spans several workspace domains (incl. *.enterprise.slack.com).
    if (link.host === hostOf(id.url) || id.enterpriseId) return;
    throw new SlackerError(
      withRunNote(`That link is from ${link.host}, but workspace "${ws.name}" is ${cfgHost ?? hostOf(id.url) ?? "a different domain"}. ${switchHint}`),
      "cross_workspace_link"
    );
  }

  /** Resolve a target (validating link hosts) to a conversation ID, for reads. */
  private async readTarget(spec: TargetSpec) {
    const c = this.client();
    if (spec.kind === "link") await this.checkLinkHost(spec.link, c);
    const channel = await c.resolver.resolveSpec(spec);
    return { ...c, channel };
  }

  /**
   * The common prelude of every write, on one client snapshot: verify identity, resolve the
   * target and describe it. A dry run to a person doesn't open the DM. A channel *name* must
   * still be called that by Slack (catches a stale directory after a rename).
   */
  private async writeTarget(spec: TargetSpec, { dryRun = false, allowAlias = false }: { dryRun?: boolean; allowAlias?: boolean }) {
    const c = this.client();
    const id = await this.verifyWriteIdentity(c, allowAlias);
    const { resolver } = c;
    let destination: Destination;
    switch (spec.kind) {
      case "conversation":
        destination = await resolver.describeConversation(spec.id, { strict: true });
        break;
      case "link":
        await this.checkLinkHost(spec.link, c);
        destination = await resolver.describeConversation(spec.link.channel, { strict: true });
        break;
      case "user": {
        const userId = await resolver.resolveUserId(spec.query);
        destination = dryRun
          ? await resolver.describeUserDM(userId)
          : await resolver.describeConversation(await resolver.openDM(userId), { strict: true });
        break;
      }
      case "channel":
        destination = await this.namedChannel(resolver, spec.name, spec.bare);
        break;
    }
    const context: WriteContext = {
      workspace: c.ws.name,
      team: id.team,
      teamDomain: hostOf(id.url) ?? null,
      destination,
      channel: destination.id,
    };
    return { ...c, context };
  }

  /** Resolve a channel name for a write and confirm Slack (fresh) still calls it that; one rescan on mismatch. */
  private async namedChannel(resolver: Resolver, name: string, bare: boolean): Promise<Destination> {
    const expected = `#${name}`;
    const matches = (d: Destination) => d.name.toLowerCase() === expected || d.name === d.id; // id = Slack wouldn't say
    let d = await resolver.describeConversation(await resolver.channelId(name, { bare }), { strict: true, fresh: true });
    if (matches(d)) return d;
    resolver.invalidateChannel(d.id ?? undefined);
    d = await resolver.describeConversation(await resolver.channelId(name, { bare }), { strict: true, fresh: true });
    if (matches(d)) return d;
    throw new SlackerError(
      `"${expected}" resolved to ${d.id}, but Slack now calls that channel ${d.name} (it was probably renamed). ` +
        "Use the channel ID or a link to the channel instead.",
      "channel_not_found"
    );
  }

  // ── Reading ────────────────────────────────────────────

  async readMessages({ target, limit = 20, oldest, latest, cursor }: {
    target: string;
    limit?: number;
    oldest?: string;
    latest?: string;
    cursor?: string;
  }) {
    const params = { oldest: toSlackTs(oldest), latest: toSlackTs(latest) };
    const { api, resolver, channel } = await this.readTarget(parseTarget(target));
    const res = await api.call<HistoryResponse>("conversations.history", { channel, limit, ...params, cursor });
    const messages = [...(res.messages ?? [])].reverse();
    const users = await resolver.userMap(messages);
    return {
      channel,
      count: messages.length,
      messages: messages.map((m) => formatMessage(m, users)),
      nextCursor: res.has_more ? res.response_metadata?.next_cursor || null : null,
      ...(res.is_limited && { note: HISTORY_LIMITED }),
    };
  }

  async readThread({ target, ts, limit = 100, cursor }: { target: string; ts?: string; limit?: number; cursor?: string }) {
    const spec = parseTarget(target);
    const link = linkOf(spec);
    const rawTs = ts ?? link?.threadTs ?? link?.ts;
    if (!rawTs) throw new SlackerError("Provide the parent message ts or a Slack message link.", "missing_ts");
    const parentTs = checkTs(rawTs, "Thread ts");
    const { api, resolver, channel } = await this.readTarget(spec);
    const res = await api.call<HistoryResponse>("conversations.replies", { channel, ts: parentTs, limit, cursor });
    const messages = res.messages ?? [];
    const users = await resolver.userMap(messages);
    const nextCursor = res.has_more ? res.response_metadata?.next_cursor || null : null;
    return {
      channel,
      threadTs: parentTs,
      count: messages.length,
      messages: messages.map((m) => formatMessage(m, users)),
      hasMore: !!nextCursor,
      nextCursor,
      ...(res.is_limited && { note: HISTORY_LIMITED }),
    };
  }

  async searchMessages({ query, limit = 20, sort = "timestamp", page = 1 }: {
    query: string;
    limit?: number;
    sort?: "timestamp" | "score";
    page?: number;
  }) {
    const { api, resolver } = this.client();
    const res = await api.call<{
      messages?: { matches?: SearchMatch[]; total?: number; paging?: { page?: number; pages?: number } };
    }>("search.messages", { query, count: limit, sort, sort_dir: "desc", page });
    const matches = res.messages?.matches ?? [];

    // DMs: name the other person instead of a bare "DM".
    const dmPeers = new Map<string, Promise<string | undefined>>();
    for (const m of matches) {
      const ch = m.channel;
      if (ch?.is_im && ch.id && !dmPeers.has(ch.id)) {
        dmPeers.set(ch.id, ch.user ? Promise.resolve(ch.user) : resolver.describeConversation(ch.id).then((d) => d.userId));
      }
    }
    const peerIds = new Map<string, string | undefined>();
    for (const [id, p] of dmPeers) peerIds.set(id, await p);
    const users = await resolver.userMap([
      ...matches,
      ...[...peerIds.values()].filter((u): u is string => !!u).map((user) => ({ user })),
    ]);

    const channelLabel = (ch: SearchMatch["channel"]) => {
      if (!ch) return undefined;
      if (ch.is_im) {
        const peer = ch.id ? peerIds.get(ch.id) : undefined;
        return peer ? `@${users[peer] ?? peer}` : "DM";
      }
      if (ch.is_mpim) return "group DM";
      return ch.name ? `#${ch.name}` : ch.id;
    };

    return {
      query,
      total: res.messages?.total ?? 0,
      page: res.messages?.paging?.page ?? page,
      pages: res.messages?.paging?.pages ?? 1,
      matches: matches.map((m) => ({
        channel: channelLabel(m.channel),
        channelId: m.channel?.id,
        channelType: m.channel?.is_im ? "dm" : m.channel?.is_mpim ? "group_dm" : m.channel?.is_private ? "private_channel" : "channel",
        user: (m.user && users[m.user]) || m.username || m.user,
        text: resolveMentions(m.text || "", users),
        ts: m.ts,
        time: tsToIso(m.ts),
        permalink: m.permalink,
      })),
    };
  }

  /**
   * Without a query this returns one Slack page (`limit` per page) plus Slack's cursor.
   * With a query, pages are fetched at full size and filtered locally until `limit` matches are
   * collected. We only ever stop at a page boundary, so a returned cursor never skips a match; if
   * the last page held more matches than fit, the result is cut to `limit` with `truncated: true`
   * and no cursor (narrow the filter or raise the limit to see the rest).
   */
  async listChannels({ joinedOnly = true, query, limit = 200, cursor }: {
    joinedOnly?: boolean;
    query?: string;
    limit?: number;
    cursor?: string;
  }) {
    const { api } = this.client();
    const method = joinedOnly ? "users.conversations" : "conversations.list";
    const needle = query?.trim().toLowerCase();
    const pageSize = needle ? (joinedOnly ? 200 : 1000) : Math.min(limit, 1000);
    const maxPages = needle ? 20 : 1;
    const channels: SlackChannel[] = [];
    let next: string | undefined = cursor;
    let pages = 0;
    do {
      const res = await api.call<{ channels?: SlackChannel[]; response_metadata?: { next_cursor?: string } }>(method, {
        types: "public_channel,private_channel",
        exclude_archived: "true",
        limit: pageSize,
        cursor: next,
      });
      pages++;
      for (const ch of res.channels ?? []) {
        if (!needle || ch.name?.toLowerCase().includes(needle)) channels.push(ch);
      }
      next = res.response_metadata?.next_cursor || undefined;
    } while (next && needle && channels.length < limit && pages < maxPages);

    const truncated = channels.length > limit;
    return {
      count: Math.min(channels.length, limit),
      channels: channels.slice(0, limit).map((ch) => ({
        id: ch.id,
        name: ch.name as string,
        private: !!ch.is_private,
        member: joinedOnly ? true : !!ch.is_member,
        members: ch.num_members,
        topic: ch.topic?.value || undefined,
        purpose: ch.purpose?.value || undefined,
      })),
      nextCursor: truncated ? null : (next ?? null),
      ...(truncated && { truncated: true }),
    };
  }

  /**
   * With a query: search people. Without: list active, non-bot users, fetching up to 5 pages to
   * fill `limit`. Each further page asks only for the remaining count, so the result never
   * exceeds `limit` and `nextCursor` never skips anyone.
   */
  async findUsers({ query, limit = 10, cursor }: { query?: string; limit?: number; cursor?: string } = {}): Promise<{
    count: number;
    users: SlackUserSummary[];
    nextCursor?: string | null;
  }> {
    const { resolver } = this.client();
    if (query?.trim()) {
      const users = await resolver.findUsers(query, Math.min(limit, 50));
      return { count: users.length, users };
    }
    const max = Math.min(limit, 200);
    const users: SlackUserSummary[] = [];
    let next: string | undefined = cursor;
    let pages = 0;
    do {
      const page = await resolver.listUsers(max - users.length, next);
      users.push(...page.users);
      next = page.nextCursor ?? undefined;
      pages++;
    } while (next && users.length < max && pages < MAX_LIST_PAGES);
    return { count: users.length, users, nextCursor: next ?? null };
  }

  async listUnread({ limit = 30 }: { limit?: number } = {}) {
    const { api, resolver } = this.client();
    const counts = await api.call<{
      channels?: CountsEntry[];
      mpims?: CountsEntry[];
      ims?: CountsEntry[];
      threads?: { has_unreads?: boolean; mention_count?: number };
    }>("client.counts", { thread_counts_by_channel: "true" });
    const tagged = [
      ...(counts.channels ?? []).map((c) => ({ ...c, kind: "channel" })),
      ...(counts.mpims ?? []).map((c) => ({ ...c, kind: "group_dm" })),
      ...(counts.ims ?? []).map((c) => ({ ...c, kind: "dm" })),
    ]
      .filter((c) => c.has_unreads || (c.mention_count ?? 0) > 0)
      .sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0) || Number(b.latest ?? 0) - Number(a.latest ?? 0));

    // describeConversation is cached and goes through the resolver's concurrency limiter.
    const conversations = await Promise.all(
      tagged.slice(0, limit).map(async (c) => {
        const d = await resolver.describeConversation(c.id);
        return {
          id: c.id,
          name: d.name,
          type: c.kind,
          mentions: c.mention_count ?? 0,
          latest: tsToIso(c.latest),
          ...(d.archived && { archived: true as const }),
        };
      })
    );

    return {
      total: tagged.length,
      threadsHaveUnreads: !!counts.threads?.has_unreads,
      threadMentions: counts.threads?.mention_count ?? 0,
      conversations,
    };
  }

  async getStatus({ user }: { user?: string } = {}) {
    const { api, resolver } = this.client();
    const userId = user ? await resolver.resolveUserId(user) : (await this.liveIdentity(api)).userId;
    const [profile, presence] = await Promise.all([
      api.call<{ profile?: StatusProfile }>("users.profile.get", { user: userId }),
      api.call<{ presence?: string }>("users.getPresence", { user: userId }).catch(() => null),
    ]);
    const p = profile.profile ?? {};
    return {
      userId,
      name: p.display_name || p.real_name || undefined,
      statusText: p.status_text || null,
      statusEmoji: p.status_emoji || null,
      statusExpires: p.status_expiration ? tsToIso(p.status_expiration) : null,
      presence: presence?.presence ?? null,
    };
  }

  // ── Writing (as you) ───────────────────────────────────
  // Each write validates its arguments before any network call, then verifies identity and the
  // destination on one client snapshot, then makes exactly one Slack write call.

  /**
   * Post a message. A message link replies in that message's thread (the thread parent for reply
   * links). `dryRun` resolves the destination and verifies identity without posting or opening a DM.
   */
  async sendMessage({ target, text, threadTs, alsoSendToChannel = false, dryRun = false, allowAlias, signal }: {
    target: string;
    text: string;
    threadTs?: string;
    alsoSendToChannel?: boolean;
    dryRun?: boolean;
  } & WriteOptions): Promise<SendResult> {
    requireText(text, "Message text is empty.");
    const spec = parseTarget(target);
    const link = linkOf(spec);
    const rawThread = threadTs ?? link?.threadTs ?? link?.ts;
    const thread = rawThread === undefined ? undefined : checkTs(rawThread, "Thread ts");
    if (alsoSendToChannel && !thread) {
      throw new SlackerError(
        "--broadcast / also_send_to_channel only applies to thread replies. Pass a thread ts (--thread / thread_ts) or a message link.",
        "broadcast_without_thread"
      );
    }

    const { api, context } = await this.writeTarget(spec, { dryRun, allowAlias });
    const base = { ...context, threadTs: thread ?? null };
    if (dryRun) return { sent: false, dryRun: true, ...base };

    const res = await api.call<{ channel: string; ts: string }>(
      "chat.postMessage",
      { channel: context.channel!, text, thread_ts: thread, reply_broadcast: thread && alsoSendToChannel ? "true" : undefined },
      { signal }
    );
    const permalink = await api
      .call<{ permalink?: string }>("chat.getPermalink", { channel: res.channel, message_ts: res.ts })
      .then((r) => r.permalink ?? null)
      .catch(() => null);
    return { sent: true, ...base, ts: res.ts, permalink };
  }

  async editMessage({ target, ts, text, allowAlias, signal }: { target: string; ts?: string; text: string } & WriteOptions) {
    requireText(text, "Message text is empty. Use delete to remove a message.");
    const spec = parseTarget(target);
    const resolvedTs = messageTs(linkOf(spec), ts);
    const { api, context } = await this.writeTarget(spec, { allowAlias });
    const res = await api.call<{ ts: string }>("chat.update", { channel: context.channel!, ts: resolvedTs, text }, { signal });
    return { edited: true, ...context, ts: res.ts };
  }

  /**
   * Delete a message. `confirm`, when given, is asked after the arguments, the identity and the
   * destination are checked (so it can show where the delete lands) and before anything is
   * deleted; answering false cancels with code `cancelled`.
   */
  async deleteMessage({ target, ts, allowAlias, signal, confirm }: {
    target: string;
    ts?: string;
    confirm?: (what: WriteContext & { ts: string }) => Promise<boolean>;
  } & WriteOptions) {
    const spec = parseTarget(target);
    const resolvedTs = messageTs(linkOf(spec), ts);
    const { api, context } = await this.writeTarget(spec, { allowAlias });
    if (confirm && !(await confirm({ ...context, ts: resolvedTs }))) throw new SlackerError("Cancelled.", "cancelled");
    await api.call("chat.delete", { channel: context.channel!, ts: resolvedTs }, { signal });
    return { deleted: true, ...context, ts: resolvedTs };
  }

  async addReaction({ target, ts, emoji, allowAlias, signal }: { target: string; ts?: string; emoji: string } & WriteOptions) {
    const name = emoji.trim().replace(/^:+|:+$/g, "");
    if (!name) throw new SlackerError("No emoji given (e.g. eyes or :eyes:).", "invalid_argument");
    const spec = parseTarget(target);
    const resolvedTs = messageTs(linkOf(spec), ts);
    const { api, context } = await this.writeTarget(spec, { allowAlias });
    try {
      await api.call("reactions.add", { channel: context.channel!, timestamp: resolvedTs, name }, { signal });
    } catch (e) {
      if (!(e instanceof SlackApiError && e.code === "already_reacted")) throw e;
    }
    return { reacted: true, ...context, ts: resolvedTs, emoji: name };
  }

  async setStatus({ text, emoji = "", expiresInMinutes = 0, allowAlias, signal }: {
    text: string;
    emoji?: string;
    expiresInMinutes?: number;
  } & WriteOptions) {
    if (!Number.isInteger(expiresInMinutes) || expiresInMinutes < 0 || expiresInMinutes > MAX_STATUS_MINUTES) {
      throw new SlackerError(
        `Status expiry must be a whole number of minutes from 0 (never) to ${MAX_STATUS_MINUTES} (one year).`,
        "invalid_status"
      );
    }
    const bare = emoji.trim().replace(/^:+|:+$/g, "");
    const emojiName = bare ? `:${bare}:` : "";

    const c = this.client();
    const id = await this.verifyWriteIdentity(c, allowAlias);
    const expiration = expiresInMinutes ? Math.floor(Date.now() / 1000) + expiresInMinutes * 60 : 0;
    await c.api.call(
      "users.profile.set",
      { profile: JSON.stringify({ status_text: text, status_emoji: emojiName, status_expiration: expiration }) },
      { signal }
    );
    return {
      status: text || emojiName ? "set" : "cleared",
      workspace: c.ws.name,
      team: id.team,
      teamDomain: hostOf(id.url) ?? null,
      text,
      emoji: emojiName,
      expires: expiration ? tsToIso(expiration) : null,
    };
  }
}
