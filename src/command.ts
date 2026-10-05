import { basename, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// config.ts imports this module too; DEFAULT_CONFIG_FILE is only read at call time, so the cycle is safe.
import { DEFAULT_CONFIG_FILE } from "./config.js";

/** Absolute path of the CLI entry point (dist/index.js next to this module). */
export function entryPath(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

let activeConfig: string | undefined;

/**
 * Remember the config file this process uses so every hint names it (`-c <file>`) when it isn't the
 * default. CLI `main` and `startServer` call this first; undefined resets to the default.
 */
export function setActiveConfig(file: string | undefined): void {
  activeConfig = file ? resolve(file) : undefined;
}

/** Double-quote an argument like the node/entry paths, escaping what a POSIX shell expands inside "…". */
function quoteArg(arg: string): string {
  return `"${arg.replace(/["\\$`]/g, "\\$&")}"`;
}

/**
 * A command the user can paste to run slacker again: `slacker` when invoked through the npm bin
 * link, otherwise the full node + entry path (works without anything on PATH). Includes
 * `-c <file>` when a non-default config file is active.
 */
export function slackerCommand(): string {
  const invoked = process.argv[1] ?? "";
  const name = basename(invoked, extname(invoked));
  const base = name === "slacker" ? "slacker" : `"${process.execPath}" "${entryPath()}"`;
  if (activeConfig && activeConfig !== resolve(DEFAULT_CONFIG_FILE)) return `${base} -c ${quoteArg(activeConfig)}`;
  return base;
}

/**
 * Messages name commands as plain `slacker …`. When that isn't how to run this install (no npm
 * link, or a non-default config file), this note says once how to run it instead:
 * `(run slacker as: "<node>" "<entry>" -c "<file>")`. Empty when plain `slacker` is right.
 */
export function runNote(): string {
  const cmd = slackerCommand();
  return cmd === "slacker" ? "" : `(run slacker as: ${cmd})`;
}

/** `text` without any run note in it (e.g. before joining several messages). */
export function stripRunNote(text: string): string {
  const note = runNote();
  return note ? text.split(`\n${note}`).join("").split(note).join("") : text;
}

/** `text` with exactly one run note, on its own line at the end (when one is needed). */
export function withRunNote(text: string): string {
  const note = runNote();
  return note ? `${stripRunNote(text)}\n${note}` : text;
}
