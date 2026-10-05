import { runNote, stripRunNote } from "./command.js";
import type { FormattedMessage } from "./format.js";

/**
 * Terminal escape sequences: CSI (`ESC [ … final`, or the 8-bit `0x9B`), string sequences (OSC `ESC ]`,
 * DCS `ESC P`, SOS `ESC X`, PM `ESC ^`, APC `ESC _`, or their 8-bit forms) up to their terminator (BEL,
 * `ESC \` or `0x9C`), and two/three-byte escapes (`ESC c`, `ESC ( B` …). An unterminated string sequence
 * only loses its introducer (`ESC ]` …), which leaves the rest as harmless text.
 */
const ESCAPE_SEQUENCE =
  /\x1b\[[0-?]*[ -/]*[@-~]|\x9b[0-?]*[ -/]*[@-~]|(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c)|\x1b[ -/]*[0-~]/g;
/** C0 controls except \t and \n, DEL, C1 controls, and the bidi embedding/override/isolate characters. */
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g;

/**
 * Make text from Slack (or any file slacker didn't write) safe to print to a terminal: removes escape
 * sequences (cursor movement, screen clearing, window titles, OSC 52 clipboard writes, hyperlinks …)
 * and every control character except newline and tab, including \r and bidi overrides. Colour codes
 * slacker adds itself are applied after this, so they survive.
 */
export function sanitizeForTerminal(s: string): string {
  return s.replace(ESCAPE_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

/** Control characters `showControls` makes visible: the same set `sanitizeForTerminal` strips. */
const SHOWN_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;

/**
 * Text the user wrote, made safe for the terminal *and* faithful: every control character
 * `sanitizeForTerminal` would delete is shown as an escape instead (`\r`, `\x1b`, `\u202e` …), so a
 * dry-run preview shows exactly what would be sent. Newlines and tabs are kept as they are.
 */
export function showControls(s: string): string {
  return s.replace(SHOWN_CONTROLS, (c) => {
    if (c === "\r") return "\\r";
    const code = c.charCodeAt(0);
    return code < 0x100 ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

/**
 * `--json` text that is safe to print to a terminal: JSON.stringify escapes only U+0000–U+001F, so
 * DEL, the C1 controls (U+0080–U+009F, e.g. the 8-bit CSI U+009B) and the bidi embedding, override
 * and isolate characters (U+202A–U+202E, U+2066–U+2069) are written as `\uXXXX` escapes too. These
 * can only occur inside JSON strings, so the result is still valid JSON and parses back to exactly
 * the same value. LRM/RLM (U+200E/U+200F) are left as they are.
 */
export function toSafeJson(data: unknown, indent: number | undefined = 2): string {
  return JSON.stringify(data, null, indent).replace(/[\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A copy of `value` with every string in it (keys too) passed through `sanitizeForTerminal`. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return sanitizeForTerminal(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeDeep) as T;
  if (typeof value === "object" && value !== null) {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value; // not a plain result object
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [sanitizeForTerminal(k), sanitizeDeep(v)])) as T;
  }
  return value;
}

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const bold = paint("1");
export const dim = paint("2");
export const green = paint("32");
export const yellow = paint("33");
export const cyan = paint("36");
export const red = paint("31");

/** ISO time → local "2026-10-05 14:03". */
export function localTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function indent(text: string, by = "  "): string {
  return text
    .split("\n")
    .map((line) => by + line)
    .join("\n");
}

/** `--json` output (results and errors): see `toSafeJson`. */
export function printJson(data: unknown) {
  console.log(toSafeJson(data));
}

export function printMessages(messages: readonly FormattedMessage[]) {
  for (const m of messages) {
    console.log(`${dim(localTime(m.time))}  ${bold(m.user)}  ${dim(m.ts ?? "")}`);
    if (m.text) console.log(indent(m.text));
    for (const f of m.files ?? []) console.log(indent(`📎 ${f.name}${f.url ? ` ${dim(f.url)}` : ""}`));
    const extras = [
      m.replyCount ? cyan(`↳ ${plural(m.replyCount, "reply", "replies")}`) : "",
      m.reactions?.length ? m.reactions.join("  ") : "",
      m.edited ? dim("(edited)") : "",
    ].filter(Boolean);
    if (extras.length) console.log(indent(extras.join("   ")));
    console.log();
  }
}

export function printNote(note: string | undefined) {
  if (note) console.log(yellow(`Note: ${note}`));
}

/** Print lines in `style`; a "(run slacker as: …)" note they share is printed once, after them. */
function printWithRunNote(lines: readonly string[], style: (s: string) => string): void {
  const note = runNote();
  let noted = false;
  for (const line of lines) {
    const bare = stripRunNote(line);
    noted ||= bare !== line;
    console.log(style(sanitizeForTerminal(bare)));
  }
  if (noted && note) console.log(dim(note));
}

export function printWarnings(warnings: readonly string[] | undefined) {
  printWithRunNote((warnings ?? []).map((w) => `Warning: ${w}`), yellow);
}

/** Dimmed follow-up notes (e.g. after auth commands). */
export function printNotes(notes: readonly string[] | undefined) {
  printWithRunNote(notes ?? [], dim);
}

/** `plural(1, "channel")` → "1 channel"; `plural(2, "match", "matches")` → "2 matches". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Where a write landed: `→ #general · team "Acme" (workspace "acme")`. */
export function destinationLine(where: string, team: string, workspace: string, lead = "→"): string {
  return `${lead} ${bold(where)} ${dim("·")} team "${team}" ${dim(`(workspace "${workspace}")`)}`;
}

/** Quote an argument for a POSIX shell when it needs it. */
export function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Print rows as aligned columns (no header). */
export function printTable(rows: string[][]) {
  // Measure visible width so ANSI color codes don't throw off alignment.
  const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell))));
  for (const row of rows) {
    console.log(
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell + " ".repeat(widths[i] - visible(cell))))
        .join("  ")
        .trimEnd()
    );
  }
}
