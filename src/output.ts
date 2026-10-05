import { runNote, stripRunNote } from "./command.js";
import type { FormattedMessage } from "./format.js";

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

export function printJson(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
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
    console.log(style(bare));
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
