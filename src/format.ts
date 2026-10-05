/** Largest |ms| a JS Date can represent. */
const MAX_DATE_MS = 8.64e15;

/** Slack ts ("1700000000.123456") → ISO-8601 string; null when missing or not a sane time. */
export function tsToIso(ts: string | number | undefined | null): string | null {
  if (ts === undefined || ts === null || ts === "") return null;
  const ms = Number(ts) * 1000;
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : null;
}

/** Convert Slack mrkdwn mentions/links into plain readable text. */
export function resolveMentions(text: string, userMap: Record<string, string>): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${userMap[id] || label || id}`)
    .replace(/<#([A-Z0-9]+)\|([^>]*)>/g, (_, id, name) => `#${name || id}`)
    .replace(/<#([A-Z0-9]+)>/g, (_, id) => `#${id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]+))?>/g, (_, label) => label || "@group")
    .replace(/<!date\^(\d+)\^[^|>]*\|([^>]*)>/g, (_, ts, fallback) => fallback || tsToIso(ts) || ts)
    .replace(/<!date\^(\d+)\^[^>]*>/g, (_, ts) => tsToIso(ts) || ts)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, kw) => `@${kw}`)
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, (_, url, label) => `${label} (${url})`)
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url)
    .replace(/<mailto:([^|>]+)(?:\|[^>]+)?>/g, (_, email) => email)
    .replace(/<(?:slack|tel|sms):[^|>]*\|([^>]+)>/g, (_, label) => label)
    .replace(/<(?:tel|sms):([^|>]+)>/g, (_, number) => number)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// ── Block Kit / attachment text extraction ──────────────

interface TextObject {
  text?: string;
}

interface RichElement {
  type?: string;
  text?: string;
  url?: string;
  user_id?: string;
  channel_id?: string;
  usergroup_id?: string;
  name?: string;
  range?: string;
  fallback?: string;
  elements?: RichElement[];
}

interface Block {
  type?: string;
  text?: TextObject | string;
  fields?: TextObject[];
  elements?: RichElement[];
}

interface Attachment {
  fallback?: string;
  pretext?: string;
  title?: string;
  text?: string;
  blocks?: Block[];
}

/** Rich-text inline elements → mrkdwn-ish text, so resolveMentions can render mentions afterwards. */
function richText(elements: RichElement[] | undefined): string {
  return (elements ?? [])
    .map((el) => {
      switch (el.type) {
        case "text":
          return el.text ?? "";
        case "link":
          return el.text ? `${el.text} (${el.url})` : (el.url ?? "");
        case "user":
          return `<@${el.user_id}>`;
        case "channel":
          return `<#${el.channel_id}>`;
        case "usergroup":
          return `<!subteam^${el.usergroup_id}>`;
        case "emoji":
          return `:${el.name}:`;
        case "broadcast":
          return `@${el.range}`;
        case "date":
          return el.fallback ?? "";
        case "rich_text_list":
          return (el.elements ?? []).map((item) => `• ${richText(item.elements)}`).join("\n") + "\n";
        case "rich_text_section":
        case "rich_text_quote":
        case "rich_text_preformatted":
          return richText(el.elements);
        default:
          return el.text ?? "";
      }
    })
    .join("");
}

function textOf(t: TextObject | string | undefined): string {
  return typeof t === "string" ? t : (t?.text ?? "");
}

/** Plain text from Block Kit blocks (rich_text, section, header, context, markdown). */
export function blocksText(blocks: Block[] | undefined): string {
  const parts: string[] = [];
  for (const b of blocks ?? []) {
    switch (b.type) {
      case "rich_text":
        // Top-level elements are paragraphs, lists, quotes… — one per line.
        parts.push(
          (b.elements ?? [])
            .map((el) => richText([el]).replace(/\n+$/, ""))
            .filter(Boolean)
            .join("\n")
        );
        break;
      case "section":
        parts.push([textOf(b.text), ...(b.fields ?? []).map(textOf)].filter(Boolean).join("\n"));
        break;
      case "header":
      case "markdown":
        parts.push(textOf(b.text));
        break;
      case "context":
        parts.push((b.elements ?? []).map((el) => el.text ?? "").filter(Boolean).join(" "));
        break;
    }
  }
  return parts.filter(Boolean).join("\n");
}

function attachmentText(a: Attachment): string {
  return a.fallback || [a.pretext, a.title, a.text].filter(Boolean).join("\n") || blocksText(a.blocks);
}

interface MessageLike {
  text?: string;
  blocks?: Block[];
  attachments?: Attachment[];
}

/** Raw (still mrkdwn-encoded) text of a message, falling back to blocks and attachments when `text` is empty. */
export function rawMessageText(msg: MessageLike): string {
  if (msg.text) return msg.text;
  return [blocksText(msg.blocks), ...(msg.attachments ?? []).map(attachmentText)].filter(Boolean).join("\n");
}

// ── Messages ─────────────────────────────────────────────

export interface SlackMessage extends MessageLike {
  ts?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  bot_profile?: { name?: string };
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number }>;
  files?: Array<{ name?: string; title?: string; mimetype?: string; permalink?: string; mode?: string }>;
  edited?: unknown;
}

/** A message as read/thread results return it. Optional keys are only present when they apply. */
export interface FormattedMessage {
  ts?: string;
  time: string | null;
  user: string;
  userId: string | null;
  text: string;
  botId?: string;
  subtype?: string;
  threadTs?: string;
  replyCount?: number;
  reactions?: string[];
  files?: Array<{ name: string; type?: string; url?: string }>;
  edited?: true;
}

/** Shape a raw Slack message into a compact, LLM-friendly object. */
export function formatMessage(msg: SlackMessage, userMap: Record<string, string>): FormattedMessage {
  const out: FormattedMessage = {
    ts: msg.ts,
    time: tsToIso(msg.ts),
    user: msg.user
      ? userMap[msg.user] || msg.user
      : msg.bot_profile?.name || msg.username || msg.bot_id || "unknown",
    userId: msg.user ?? null,
    text: resolveMentions(rawMessageText(msg), userMap),
  };
  if (msg.bot_id) out.botId = msg.bot_id;
  if (msg.subtype) out.subtype = msg.subtype;
  if (msg.thread_ts) out.threadTs = msg.thread_ts;
  if (msg.reply_count) out.replyCount = msg.reply_count;
  if (msg.reactions?.length) out.reactions = msg.reactions.map((r) => `:${r.name}: ×${r.count}`);
  if (msg.files?.length) {
    out.files = msg.files.map((f) => ({
      name: f.name ?? f.title ?? (f.mode === "tombstone" ? "(deleted file)" : "(file)"),
      type: f.mimetype,
      url: f.permalink,
    }));
  }
  if (msg.edited) out.edited = true;
  return out;
}
