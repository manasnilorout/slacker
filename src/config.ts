import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, isAbsolute, join, parse } from "node:path";
import { createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { withRunNote } from "./command.js";
import { SlackerError } from "./errors.js";
import { foreignProjectRefusal, RESTART, Surface, untrustedProjectRefusal } from "./messages.js";
import { errorMessage, formatIssues, isPlainObject } from "./util.js";

export interface WorkspaceConfig {
  token: string;
  cookie: string;
  url: string;
  userId: string;
  teamId: string;
  /** Keys written by slack-cli or newer versions are preserved on save. */
  [key: string]: unknown;
}

export interface SlackCliConfig {
  workspaces: Record<string, WorkspaceConfig>;
  defaultWorkspace: string | null;
  [key: string]: unknown;
}

export type ResolvedWorkspace = WorkspaceConfig & { name: string };

export const DEFAULT_CONFIG_FILE = join(homedir(), ".config", "slack-cli", "config.json");

/** Config file path: SLACKER_CONFIG env var overrides the shared slack-cli location. */
export function configPath(override?: string): string {
  return override || process.env.SLACKER_CONFIG || DEFAULT_CONFIG_FILE;
}

/** Validate the parsed file in place (unknown keys are kept so saving doesn't drop them). */
function validateConfig(parsed: unknown, file: string): SlackCliConfig {
  const bad = (what: string) =>
    new SlackerError(
      withRunNote(`Invalid Slack config at ${file}: ${what}. Fix the file by hand, or move it aside and run: slacker auth setup`),
      "invalid_config"
    );

  if (!isPlainObject(parsed)) throw bad("expected a JSON object at the top level");
  const workspaces = parsed.workspaces ?? {};
  if (!isPlainObject(workspaces)) throw bad(`"workspaces" must be an object mapping names to credentials`);
  for (const [name, ws] of Object.entries(workspaces)) {
    if (!isPlainObject(ws)) throw bad(`workspace "${name}" must be an object`);
    for (const key of ["token", "cookie"]) {
      if (typeof ws[key] !== "string" || !ws[key]) throw bad(`workspace "${name}" is missing a string "${key}"`);
    }
    for (const key of ["url", "userId", "teamId"]) {
      if (ws[key] === undefined) ws[key] = "";
      else if (typeof ws[key] !== "string") throw bad(`workspace "${name}" has a non-string "${key}"`);
    }
  }
  const def = parsed.defaultWorkspace ?? null;
  if (def !== null && typeof def !== "string") throw bad(`"defaultWorkspace" must be a string or null`);
  parsed.workspaces = workspaces;
  parsed.defaultWorkspace = def;
  return parsed as SlackCliConfig;
}

export function loadConfig(file = configPath()): SlackCliConfig {
  if (!existsSync(file)) return { workspaces: {}, defaultWorkspace: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new SlackerError(
      withRunNote(`Could not parse Slack config at ${file}: ${errorMessage(e)}. Fix the file by hand, or move it aside and run: slacker auth setup`),
      "invalid_config"
    );
  }
  return validateConfig(parsed, file);
}

const DEFAULT_CONFIG_DIR = dirname(DEFAULT_CONFIG_FILE);

/** Create the config dir as 0700; only tighten an existing dir when it's slack-cli's own. */
function ensureConfigDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    return;
  }
  if (platform() === "win32") return;
  let isDefault = dir === DEFAULT_CONFIG_DIR;
  try {
    isDefault ||= realpathSync(dir) === realpathSync(DEFAULT_CONFIG_DIR);
  } catch {
    // default dir doesn't exist
  }
  if (isDefault && (statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
}

/** Follow a symlinked file (dotfiles) so the link stays a link; a missing file is its own target. */
function realTarget(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * Write `data` to a temp file next to `target`, fsync, set `mode`, rename over `target`. The temp
 * file is removed on any failure, so a full disk or a bad directory never leaves debris behind.
 */
function replaceFile(target: string, data: string, mode: number): void {
  const tmp = `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", mode);
    try {
      writeSync(fd, data);
      fchmodSync(fd, mode); // openSync's mode is subject to the umask
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Atomically replace `file` with `data` (readers never see a half-written file). An existing file
 * keeps its permission bits (minus `opts.clearBits`); a new one gets `mode`. Symlinks are written
 * through — callers writing into a directory they don't control check the link first (see init).
 */
export function writeFileAtomic(file: string, data: string, mode = 0o644, opts: { clearBits?: number } = {}): void {
  const target = realTarget(file);
  let keep = mode;
  try {
    keep = statSync(target).mode & 0o777;
  } catch {
    // new file
  }
  replaceFile(target, data, keep & ~(opts.clearBits ?? 0));
}

/**
 * Atomic save as 0600 (re-tightened every time). The MCP server re-reads the config per call, so
 * it never sees a half-written file. Read-modify-write callers should use `updateConfig` instead.
 */
export function saveConfig(config: SlackCliConfig, file = configPath()): void {
  const target = realTarget(file);
  ensureConfigDir(dirname(target));
  replaceFile(target, JSON.stringify(config, null, 2) + "\n", 0o600);
}

export interface LockOptions {
  /** How long to wait for another writer before giving up (default 2s). */
  waitMs?: number;
  /** A lock file older than this is from a crashed process and is taken over (default 10s). */
  staleMs?: number;
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Take `<target>.lock` with O_EXCL; returns the token written into it (to release only our own lock). */
function acquireLock(lock: string, file: string, opts: LockOptions): string {
  const waitMs = opts.waitMs ?? 2000;
  const staleMs = opts.staleMs ?? 10_000;
  const token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (e) {
      if ((e as { code?: unknown }).code !== "EEXIST") throw e;
    }
    let seen: { ino: number; mtimeMs: number };
    try {
      seen = statSync(lock);
    } catch {
      continue; // released between our open and stat
    }
    if (Date.now() - seen.mtimeMs > staleMs) {
      removeStaleLock(lock, seen); // left behind by a crashed process (unless someone just replaced it)
      continue;
    }
    if (Date.now() >= until) {
      throw new SlackerError(
        `Another slacker process is updating ${file} (lock file ${lock}). Try again in a moment; ` +
          `if no other slacker command is running, delete the lock file.`,
        "config_locked"
      );
    }
    sleepSync(50);
  }
}

/**
 * Remove a lock judged stale, but only if it is still that same file: another process may have
 * taken it over (and created a fresh lock) between our stat and now. The lock is moved aside
 * atomically first, so the check and the removal can't be split by a third process; a fresh lock
 * grabbed by mistake is put back. Returns whether the stale lock was removed.
 */
export function removeStaleLock(lock: string, stale: { ino: number; mtimeMs: number }): boolean {
  const aside = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(lock, aside);
  } catch {
    return false; // already released or taken over
  }
  try {
    const now = statSync(aside);
    if (now.ino === stale.ino && now.mtimeMs === stale.mtimeMs) return true;
    try {
      linkSync(aside, lock); // a fresh lock: give it back (fails only if yet another process holds the lock now)
    } catch {
      // the lock is held by someone else again
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

function releaseLock(lock: string, token: string): void {
  try {
    if (readFileSync(lock, "utf-8") === token) rmSync(lock, { force: true });
  } catch {
    // already gone (taken over as stale)
  }
}

/**
 * Read-modify-write config.json under a lock: load a fresh copy, let `mutate` change it, save it
 * atomically if anything changed. Concurrent slacker processes (CLI + MCP servers) can't lose
 * each other's updates. If `mutate` throws, nothing is written.
 */
export function updateConfig<R>(file: string, mutate: (config: SlackCliConfig) => R, opts: LockOptions = {}): R {
  const target = realTarget(file);
  ensureConfigDir(dirname(target));
  const lock = `${target}.lock`;
  const token = acquireLock(lock, file, opts);
  try {
    const config = loadConfig(file);
    const before = JSON.stringify(config);
    const result = mutate(config);
    if (JSON.stringify(config) !== before) saveConfig(config, file);
    return result;
  } finally {
    releaseLock(lock, token);
  }
}

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function validateWorkspaceName(name: string): void {
  if (!WORKSPACE_NAME.test(name)) {
    throw new SlackerError(
      `Invalid workspace name "${name}": use letters, digits, ".", "_" or "-" (starting with a letter or digit).`,
      "invalid_workspace_name"
    );
  }
}

/**
 * Put a workspace into an already-loaded config (for use inside `updateConfig`). Unknown keys of an
 * existing entry for the same team are kept. Becomes the default only when it's the first workspace.
 */
export function putWorkspace(config: SlackCliConfig, name: string, ws: WorkspaceConfig): void {
  validateWorkspaceName(name);
  const wasEmpty = Object.keys(config.workspaces).length === 0;
  const existing = Object.hasOwn(config.workspaces, name) ? config.workspaces[name] : undefined;
  config.workspaces[name] = existing && existing.teamId === ws.teamId ? { ...existing, ...ws } : ws;
  if (wasEmpty && !config.defaultWorkspace) config.defaultWorkspace = name;
}

/** Add or replace a workspace (locked read-modify-write; see `putWorkspace`). */
export function addWorkspace(name: string, ws: WorkspaceConfig, file = configPath()): void {
  validateWorkspaceName(name);
  updateConfig(file, (config) => putWorkspace(config, name, ws));
}

/** Where a workspace name came from, for error messages: "from --workspace", "defaultWorkspace in config.json"… */
export function describeSource(choice: { source: WorkspaceSource; projectFile?: string }): string {
  switch (choice.source) {
    case "flag":
      return "from --workspace";
    case "env":
      return "from SLACKER_WORKSPACE";
    case "project":
      return `from ${PROJECT_FILE} at ${choice.projectFile ?? "(unknown path)"}`;
    case "default":
      return "defaultWorkspace in config.json";
  }
}

/**
 * Pick a workspace by name. With no name, fall back to the config's defaultWorkspace.
 * Throws a descriptive error listing the available workspaces when nothing matches; `from` (how
 * the name was chosen) is named in that error so the user knows what to correct.
 */
export function resolveWorkspace(
  name: string | undefined,
  file = configPath(),
  from?: { source: WorkspaceSource; projectFile?: string }
): ResolvedWorkspace {
  const config = loadConfig(file);
  const available = Object.keys(config.workspaces);
  const explicit = name?.trim();
  const wsName = explicit || config.defaultWorkspace;

  if (!available.length) {
    throw new SlackerError(
      withRunNote(`No Slack workspaces found in ${file}. Run 'slacker auth setup' to import them from the Slack desktop app.`),
      "no_workspaces",
      withRunNote("slacker auth setup")
    );
  }
  if (!wsName) {
    throw new SlackerError(
      withRunNote(
        `No workspace specified and no defaultWorkspace set in ${file}. Available: ${available.join(", ")}. ` +
          `Pass --workspace <name>, or set a default with: slacker auth default <name>`
      ),
      "no_default_workspace",
      withRunNote("slacker auth default <name>")
    );
  }
  if (!Object.hasOwn(config.workspaces, wsName)) {
    const source = explicit ? from && describeSource(from) : describeSource({ source: "default" });
    throw new SlackerError(
      `Workspace "${wsName}"${source ? ` (${source})` : ""} not found in ${file}. Available: ${available.join(", ")}`,
      "workspace_not_found"
    );
  }
  return { ...config.workspaces[wsName], name: wsName };
}

/** Other workspace names in config.json that point at the same Slack team as `name`. */
export function teamAliases(name: string, file = configPath()): string[] {
  const config = loadConfig(file);
  if (!Object.hasOwn(config.workspaces, name)) return [];
  const teamId = config.workspaces[name].teamId;
  if (!teamId) return [];
  return Object.entries(config.workspaces)
    .filter(([other, ws]) => other !== name && ws.teamId === teamId)
    .map(([other]) => other);
}

/** Groups (≥2) of workspace names that share a teamId — usually a copy-pasted entry. */
export function findDuplicateTeams(config: SlackCliConfig): string[][] {
  const byTeam = new Map<string, string[]>();
  for (const [name, ws] of Object.entries(config.workspaces)) {
    if (ws.teamId) byTeam.set(ws.teamId, [...(byTeam.get(ws.teamId) ?? []), name]);
  }
  return [...byTeam.values()].filter((names) => names.length > 1);
}

// ── Per-project settings ─────────────────────────────────

export const PROJECT_FILE = ".slacker.json";

export interface ProjectSettings {
  workspace?: string;
  readOnly?: boolean;
}

export const ProjectSettingsSchema = z.object({
  workspace: z.string().trim().min(1, "must be a non-empty workspace name").optional(),
  readOnly: z.boolean("must be true or false").optional(),
});

/** Parse a .slacker.json's contents (`text`, already read from `file`). */
function parseProjectSettings(text: string, file: string): ProjectSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new SlackerError(
      withRunNote(`Could not parse ${file}: ${errorMessage(e)}. Fix it or delete it, then run: slacker init.`),
      "invalid_project_file"
    );
  }
  const result = ProjectSettingsSchema.safeParse(raw);
  if (!result.success) {
    throw new SlackerError(
      `Invalid ${file}: ${formatIssues(result.error.issues)}. Expected {"workspace": "<name>", "readOnly": true|false}.`,
      "invalid_project_file"
    );
  }
  return result.data;
}

/**
 * Directories to start the upward search from. When the shell's logical $PWD (which keeps symlinks)
 * is the same directory as `start`, search its ancestors first so a .slacker.json above a symlink
 * is still found.
 */
function searchStarts(start: string): string[] {
  const pwd = process.env.PWD;
  if (pwd && isAbsolute(pwd) && pwd !== start) {
    try {
      if (realpathSync(pwd) === realpathSync(start)) return [pwd, start];
    } catch {
      // stale PWD
    }
  }
  return [start];
}

/** Open flags for checking a file before reading it: a FIFO planted as the file must not block the open. */
const OPEN_FOR_CHECK = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);

/** What `inspectOwnedFile` found. */
export interface OwnedFileCheck {
  /** Why another local user may control the file, or undefined when it's yours (see `foreignReason`). */
  reason?: string;
  /** How to fix it ("chmod go-w <file>" …), when `reason` is set. */
  fix?: string;
  /** You own the file and only its group may also write it (D6: usable for "readOnly" when -w names the workspace). */
  groupWritableOnly?: boolean;
  /** The contents, read from the same open file that was checked (with `read`, when it's yours or only group-writable). */
  text?: string;
}

/** A directory other users may create or swap files in: writable by others without the sticky bit. */
function openDirectory(dir: string): { reason: string; fix: string } | undefined {
  let st;
  try {
    st = statSync(dir);
  } catch {
    return undefined;
  }
  if (!(st.mode & 0o002) || st.mode & 0o1000) return undefined;
  return {
    reason: `is in ${dir}, which other users can write to (mode ${(st.mode & 0o7777).toString(8)}, no sticky bit)`,
    fix: `chmod o-w ${dir}, or move the project`,
  };
}

/**
 * Check who controls `file` and (with `read`) read it, all through one open file descriptor, so the
 * file can't be swapped between the check and the read. It (and a symlink to it) must be owned by
 * you, be a regular file, not be writable by group or others, and not sit in a directory others can
 * write to (without the sticky bit) — otherwise another local user (e.g. in a shared /tmp) could have
 * planted it or could change it. Ownership and modes aren't checked on Windows.
 */
export function inspectOwnedFile(file: string, read = false): OwnedFileCheck {
  const uid = process.getuid?.();
  const posix = platform() !== "win32" && uid !== undefined;
  if (posix) {
    // Before opening anything: a symlink someone else planted may point at a device.
    try {
      const link = lstatSync(file);
      if (link.isSymbolicLink() && link.uid !== uid) return { reason: `is a symlink owned by another user (uid ${link.uid})`, fix: "chown it" };
    } catch (e) {
      return { reason: `can't be read (${errorMessage(e)})`, fix: "make it readable" };
    }
  }
  let fd: number;
  try {
    fd = openSync(file, OPEN_FOR_CHECK);
  } catch (e) {
    return { reason: `can't be read (${errorMessage(e)})`, fix: "make it readable" };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { reason: "is not a regular file", fix: "replace it with a regular file" };
    const contents = () => (read ? { text: readFileSync(fd, "utf-8") } : {});
    if (!posix) return contents();
    if (st.uid !== uid) return { reason: `is owned by another user (uid ${st.uid})`, fix: "chown it" };
    for (const dir of new Set([dirname(file), dirname(trustKey(file))])) {
      const open = openDirectory(dir);
      if (open) return open;
    }
    if (st.mode & 0o022) {
      const groupOnly = !(st.mode & 0o002);
      const who = groupOnly ? "its group" : st.mode & 0o020 ? "group and others" : "others";
      return {
        reason: `is writable by ${who} (mode ${(st.mode & 0o777).toString(8)})`,
        fix: `chmod go-w ${file}`,
        ...(groupOnly && { groupWritableOnly: true, ...contents() }),
      };
    }
    return contents();
  } finally {
    closeSync(fd);
  }
}

/** Why a file can't be trusted because of who controls it, or undefined when it's yours (see `inspectOwnedFile`). */
export function foreignReason(file: string): string | undefined {
  return inspectOwnedFile(file).reason;
}

/**
 * The key trust records use for a file: its canonical realpath (`realpathSync.native`, which also
 * fixes the case on case-insensitive file systems). A missing file is keyed by its directory's realpath.
 */
export function trustKey(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    try {
      return join(realpathSync.native(dirname(file)), basename(file));
    } catch {
      return file;
    }
  }
}

export interface ProjectLookup {
  /** The path where it was found. */
  file: string;
  /** Its canonical realpath (what trust records are keyed by: `trustKey`). */
  realFile: string;
  /** Empty when `foreign` is set (a foreign file isn't parsed). */
  settings: ProjectSettings;
  /** Set when ownership/permissions make the file untrusted: why (see `inspectOwnedFile`). */
  foreign?: string;
  /** How to fix `foreign`. */
  fix?: string;
  /** `foreign` only because its group may write it (you own it): `parse` reads the settings anyway. */
  groupWritableOnly?: boolean;
  /** With `groupWritableOnly`: parse the contents read when it was checked (may throw invalid_project_file). */
  parse?: () => ProjectSettings;
}

/**
 * Find the nearest .slacker.json walking up from `start`. A file someone else controls (`foreign`) is
 * returned unparsed: callers ignore it for reads and refuse writes.
 */
export function findProjectSettings(start = process.cwd()): ProjectLookup | null {
  const seen = new Set<string>();
  for (const from of searchStarts(start)) {
    let dir = from;
    const { root } = parse(dir);
    while (!seen.has(dir)) {
      seen.add(dir);
      const file = join(dir, PROJECT_FILE);
      if (existsSync(file)) {
        const realFile = trustKey(file);
        const check = inspectOwnedFile(file, true);
        if (check.reason) {
          const { text = "" } = check;
          return {
            file,
            realFile,
            settings: {},
            foreign: check.reason,
            ...(check.fix && { fix: check.fix }),
            ...(check.groupWritableOnly && { groupWritableOnly: true, parse: () => parseProjectSettings(text, file) }),
          };
        }
        return { file, realFile, settings: parseProjectSettings(check.text ?? "", file) };
      }
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  return null;
}

// ── Project trust ────────────────────────────────────────
// A .slacker.json may always restrict ("readOnly": true), but it only chooses the workspace for
// writes once you've trusted it on this machine (`slacker trust`, or `slacker init` writing it).

/** Where trust records live: SLACKER_TRUST_FILE, else ~/.config/slacker/trusted-projects.json. */
export function trustFilePath(): string {
  return process.env.SLACKER_TRUST_FILE || join(homedir(), ".config", "slacker", "trusted-projects.json");
}

export interface TrustRecord {
  workspace: string;
  trustedAt: string;
}

export interface TrustStore {
  version: 1;
  /** Project file realpath → the workspace it was trusted for. */
  projects: Record<string, TrustRecord>;
  [key: string]: unknown;
}

/**
 * The trust store (empty when the file doesn't exist). A corrupt one, or one someone else could have
 * written (same ownership/mode checks as a .slacker.json), is an error (`invalid_trust_file`): callers
 * then treat every project file as untrusted.
 */
export function loadTrust(file = trustFilePath()): TrustStore {
  if (!existsSync(file)) return { version: 1, projects: {} };
  const check = inspectOwnedFile(file, true);
  if (check.reason) {
    throw new SlackerError(
      `Ignoring the trust file ${file}: it ${check.reason}, so someone else could have added trust records. ` +
        `Until it's fixed, no ${PROJECT_FILE} counts as trusted. Fix it (${check.fix ?? `chmod 600 ${file}`}), ` +
        "or delete it and run slacker trust again in your projects.",
      "invalid_trust_file"
    );
  }
  const bad = (why: string) =>
    new SlackerError(`Invalid trust file ${file}: ${why}. Fix it or delete it (then re-run slacker trust in your projects).`, "invalid_trust_file");
  let parsed: unknown;
  try {
    parsed = JSON.parse(check.text ?? "");
  } catch (e) {
    throw bad(errorMessage(e));
  }
  if (!isPlainObject(parsed)) throw bad("expected a JSON object");
  const projects = parsed.projects ?? {};
  if (!isPlainObject(projects)) throw bad(`"projects" must be an object`);
  const clean: Record<string, TrustRecord> = {};
  for (const [path, rec] of Object.entries(projects)) {
    if (isPlainObject(rec) && typeof rec.workspace === "string") {
      clean[path] = { workspace: rec.workspace, trustedAt: typeof rec.trustedAt === "string" ? rec.trustedAt : "" };
    }
  }
  return { ...parsed, version: 1, projects: clean };
}

/** The workspace `realFile` is trusted for, if any. */
export function trustedWorkspace(realFile: string, file = trustFilePath()): string | undefined {
  const store = loadTrust(file);
  return Object.hasOwn(store.projects, realFile) ? store.projects[realFile].workspace : undefined;
}

/** Locked read-modify-write of the trust store (0600 in a 0700 directory). */
export function updateTrust<R>(mutate: (store: TrustStore) => R, file = trustFilePath()): R {
  const target = realTarget(file);
  const dir = dirname(target);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  const lock = `${target}.lock`;
  const token = acquireLock(lock, file, {});
  try {
    const store = loadTrust(file);
    const before = JSON.stringify(store);
    const result = mutate(store);
    if (JSON.stringify(store) !== before) replaceFile(target, JSON.stringify(store, null, 2) + "\n", 0o600);
    return result;
  } finally {
    releaseLock(lock, token);
  }
}

/** Trust `realFile` to choose `workspace`. Returns the workspace it was trusted for before, if any. */
export function recordTrust(realFile: string, workspace: string, file = trustFilePath()): string | undefined {
  return updateTrust((store) => {
    const previous = Object.hasOwn(store.projects, realFile) ? store.projects[realFile].workspace : undefined;
    if (previous !== workspace) store.projects[realFile] = { workspace, trustedAt: new Date().toISOString() };
    return previous;
  }, file);
}

/** Forget `realFile`. Returns the workspace it was trusted for, or undefined when it wasn't. */
export function removeTrust(realFile: string, file = trustFilePath()): string | undefined {
  return updateTrust((store) => {
    if (!Object.hasOwn(store.projects, realFile)) return undefined;
    const previous = store.projects[realFile].workspace;
    delete store.projects[realFile];
    return previous;
  }, file);
}

/**
 * Env flag parsing that fails closed: unset/empty/0/false/no/off are false; 1/true/yes/on and
 * anything unrecognised are true (so a typo'd SLACKER_READ_ONLY still means read-only).
 */
export function parseBoolEnv(value: string | undefined): boolean {
  const v = (value ?? "").trim().toLowerCase();
  if (["", "0", "false", "no", "off"].includes(v)) return false;
  return true;
}

export type WorkspaceSource = "flag" | "env" | "project" | "default";

export interface WorkspaceChoice {
  /** undefined means "use defaultWorkspace from config.json". */
  name?: string;
  source: WorkspaceSource;
  projectFile?: string;
  readOnly: boolean;
  /** Set when an invalid .slacker.json was skipped (`ignoreInvalidProject`): why it was. */
  ignoredProjectError?: string;
  /**
   * When `projectFile` names a workspace: whether you trusted that file for that workspace
   * (`slacker trust` / `slacker init`). Only a trusted file may choose the workspace for writes.
   */
  projectTrusted?: boolean;
  /** The workspace the trust record has for `projectFile`, when it differs from the file's (or is missing: undefined). */
  trustedFor?: string;
  /** Why the trust record couldn't be read (a corrupt trust file counts as untrusted). */
  trustError?: string;
  /**
   * The nearest .slacker.json was ignored because someone else controls it (owner/permissions):
   * reads fall through to the next source; writes are refused, since it might say read-only.
   */
  foreignProject?: { file: string; reason: string; fix?: string };
  /**
   * D6: the nearest .slacker.json is yours but writable by its group, and -w / SLACKER_WORKSPACE named
   * the workspace, so the file only contributes "readOnly" (writes aren't blocked; a warning is shown).
   */
  groupWritableProject?: { file: string; reason: string };
}

/**
 * Decide which workspace to use. First match wins:
 * --workspace flag > SLACKER_WORKSPACE env > nearest .slacker.json > defaultWorkspace.
 * An invalid .slacker.json throws (`invalid_project_file`) — it may say `"readOnly": true` —
 * unless `ignoreInvalidProject` is set (callers that never write), which skips it and reports why.
 * A .slacker.json someone else controls is ignored (`foreignProject`); whether the one used is
 * trusted is reported in `projectTrusted` (see `projectWriteBlock`).
 */
export function chooseWorkspace(flag?: string, cwd = process.cwd(), opts: { ignoreInvalidProject?: boolean } = {}): WorkspaceChoice {
  const env = process.env.SLACKER_WORKSPACE?.trim();
  const flagName = flag?.trim();
  let found: ProjectLookup | null = null;
  let ignoredProjectError: string | undefined;
  const skipInvalid = (e: unknown) => {
    if (!(opts.ignoreInvalidProject && e instanceof SlackerError && e.code === "invalid_project_file")) throw e;
    ignoredProjectError = e.message;
  };
  try {
    found = findProjectSettings(cwd);
  } catch (e) {
    skipInvalid(e);
  }
  let foreignProject: WorkspaceChoice["foreignProject"] = found?.foreign ? { file: found.file, reason: found.foreign, ...(found.fix && { fix: found.fix }) } : undefined;
  let project = foreignProject ? null : found;
  let groupWritableProject: WorkspaceChoice["groupWritableProject"];
  if (found?.foreign && found.groupWritableOnly && found.parse && (flagName || env)) {
    // Yours, only group-writable, and the workspace is named elsewhere: honour its "readOnly" (fail closed) and warn.
    foreignProject = undefined;
    groupWritableProject = { file: found.file, reason: found.foreign };
    try {
      project = { ...found, settings: found.parse() };
    } catch (e) {
      skipInvalid(e);
    }
  }
  const readOnly = project?.settings.readOnly === true || parseBoolEnv(process.env.SLACKER_READ_ONLY);

  let trust: Pick<WorkspaceChoice, "projectTrusted" | "trustedFor" | "trustError"> = {};
  const projectWorkspace = groupWritableProject ? undefined : project?.settings.workspace;
  if (project && projectWorkspace) {
    try {
      const recorded = trustedWorkspace(project.realFile);
      trust = { projectTrusted: recorded === projectWorkspace, ...(recorded !== undefined && recorded !== projectWorkspace && { trustedFor: recorded }) };
    } catch (e) {
      trust = { projectTrusted: false, trustError: errorMessage(e) };
    }
  }

  const base = {
    projectFile: project?.file,
    readOnly,
    ...(ignoredProjectError !== undefined && { ignoredProjectError }),
    ...trust,
    ...(foreignProject && { foreignProject }),
    ...(groupWritableProject && { groupWritableProject }),
  };
  if (flagName) return { ...base, name: flagName, source: "flag" };
  if (env) return { ...base, name: env, source: "env" };
  if (projectWorkspace) return { ...base, name: projectWorkspace, source: "project" };
  return { ...base, source: "default" };
}

/**
 * Why writes must be refused because of an untrusted .slacker.json (code `untrusted_project`), or
 * undefined. Refused when the nearest .slacker.json is controlled by someone else (it might say
 * read-only; -w doesn't help), or when the workspace was chosen by a .slacker.json you haven't
 * trusted for that workspace (-w or SLACKER_WORKSPACE bypass the file's choice). `surface` picks the
 * advice: a person at the CLI, or an agent over MCP (no -w, ask the user).
 */
export function projectWriteBlock(choice: WorkspaceChoice, surface: Surface = "cli"): SlackerError | undefined {
  const f = choice.foreignProject;
  if (f) return new SlackerError(foreignProjectRefusal(f.file, f.reason, f.fix, surface), "untrusted_project", `fix or remove ${f.file}`);
  if (choice.source !== "project" || choice.projectTrusted) return undefined;
  const file = choice.projectFile ?? PROJECT_FILE;
  const why = choice.trustError
    ? ` (the trust record couldn't be read: ${choice.trustError})`
    : choice.trustedFor !== undefined
      ? ` (you trusted it for workspace "${choice.trustedFor}", but it now says "${choice.name}")`
      : "";
  return new SlackerError(
    untrustedProjectRefusal(file, choice.name ?? "", why, surface),
    "untrusted_project",
    withRunNote(`check that "${choice.name}" is right, then run slacker trust in ${dirname(file)}`)
  );
}

/**
 * D3: the project-file check, run again right before a write (the CLI's one write, or every MCP write
 * call): `start` is the choice the session was set up with. Refuses (fails closed) when the project
 * file is now invalid, untrusted or someone else's, when it now picks another workspace than the
 * session uses (`project_changed`), or when it now says read-only. So `slacker trust` and
 * `trust --remove` take effect on the next write, without reconnecting an MCP server.
 */
export function recheckWriteBlock(start: WorkspaceChoice, o: { cwd: string; flag?: string; surface?: Surface }): SlackerError | undefined {
  let now: WorkspaceChoice;
  try {
    now = chooseWorkspace(o.flag, o.cwd);
  } catch (e) {
    return e instanceof SlackerError ? e : new SlackerError(errorMessage(e), "invalid_project_file");
  }
  const block = projectWriteBlock(now, o.surface);
  if (block) return block;
  if ((start.source === "project" || now.source === "project") && (now.source !== start.source || now.name !== start.name)) {
    const was = start.name ? `workspace "${start.name}" (${describeSource(start)})` : "the default workspace";
    const is = now.source === "project" ? `${now.projectFile ?? PROJECT_FILE} now picks "${now.name}"` : `no ${PROJECT_FILE} picks it any more`;
    const fix = o.surface === "mcp" ? `Ask the user to ${RESTART}` : "Run the command again";
    return new SlackerError(`Refusing to write: this ${o.surface === "mcp" ? "server" : "command"} started with ${was}, but ${is}. ${fix} to pick up the change.`, "project_changed");
  }
  if (now.readOnly && !start.readOnly) {
    const why = now.projectFile && !parseBoolEnv(process.env.SLACKER_READ_ONLY) ? `"readOnly": true in ${now.projectFile}` : "SLACKER_READ_ONLY is set";
    return new SlackerError(`Refusing to write: this project is now read-only (${why}).`, "read_only");
  }
  return undefined;
}

/** D6: the warning for a group-writable .slacker.json used only for "readOnly" (shown for reads and writes). */
export function projectWriteWarnings(choice: WorkspaceChoice): string[] {
  const g = choice.groupWritableProject;
  if (!g) return [];
  const by = choice.source === "env" ? "SLACKER_WORKSPACE" : "-w";
  return [
    `${g.file} ${g.reason}, so only its "readOnly" is used (${by} picks the workspace); without ${by} it's ignored and writes are refused. Fix: chmod g-w ${g.file}`,
  ];
}

/** One-line stderr warnings for reads that use or skip an untrusted .slacker.json (empty when there's nothing to say). */
export function projectReadWarnings(choice: WorkspaceChoice): string[] {
  const out: string[] = projectWriteWarnings(choice);
  const f = choice.foreignProject;
  if (f) out.push(`Ignoring ${f.file}: it ${f.reason}. Writes are refused while it's there.`);
  if (choice.source === "project" && !choice.projectTrusted) {
    out.push(`Using workspace "${choice.name}" from untrusted ${choice.projectFile ?? PROJECT_FILE}; run slacker trust to silence`);
  }
  return out;
}

export interface TrustResult {
  action: "trusted" | "already_trusted" | "removed" | "not_trusted";
  file: string;
  /** The path trust is recorded under (the file's realpath). */
  realFile: string;
  /** The workspace now trusted (trust) or that was trusted (remove). */
  workspace: string | null;
  /** The workspace it was trusted for before, when that changed. */
  previous: string | null;
  trustFile: string;
}

function nearestProject(cwd: string): ProjectLookup {
  const found = findProjectSettings(cwd);
  if (!found) {
    throw new SlackerError(`No ${PROJECT_FILE} found in ${cwd} or any directory above it. Create one with: slacker init <workspace>`, "no_project_file");
  }
  return found;
}

/**
 * `slacker trust`: allow the nearest .slacker.json, as it is now, to choose the workspace for writes.
 * Refused for a file someone else controls; the workspace must exist in config.json.
 */
export function trustProject(cwd: string, configFile = configPath()): TrustResult {
  const found = nearestProject(cwd);
  if (found.foreign) {
    throw new SlackerError(
      `Won't trust ${found.file}: it ${found.foreign}. If it's yours, fix it (${found.fix ?? "chmod go-w, or chown it"}) and run slacker trust again.`,
      "untrusted_project"
    );
  }
  const workspace = found.settings.workspace;
  if (!workspace) {
    throw new SlackerError(`${found.file} doesn't choose a workspace, so there is nothing to trust (its "readOnly" applies either way).`, "invalid_project_file");
  }
  resolveWorkspace(workspace, configFile, { source: "project", projectFile: found.file });
  const previous = recordTrust(found.realFile, workspace);
  return {
    action: previous === workspace ? "already_trusted" : "trusted",
    file: found.file,
    realFile: found.realFile,
    workspace,
    previous: previous !== undefined && previous !== workspace ? previous : null,
    trustFile: trustFilePath(),
  };
}

/** `slacker trust --remove [file]`: forget the nearest .slacker.json (or `file`, which may no longer exist). */
export function untrustProject(cwd: string, file?: string): TrustResult {
  let path: string;
  let realFile: string;
  if (file) {
    path = isAbsolute(file) ? file : join(cwd, file);
    realFile = trustKey(path);
  } else {
    ({ file: path, realFile } = nearestProject(cwd));
  }
  const previous = removeTrust(realFile);
  return {
    action: previous === undefined ? "not_trusted" : "removed",
    file: path,
    realFile,
    workspace: previous ?? null,
    previous: null,
    trustFile: trustFilePath(),
  };
}

/** `slacker trust --list`: every trusted project file, and whether it still names the trusted workspace. */
/** ok: still names the trusted workspace; changed: names another one (writes refused); foreign: someone else may control it now. */
export type TrustStatus = "ok" | "changed" | "missing" | "invalid" | "foreign";

export interface TrustListEntry {
  file: string;
  workspace: string;
  trustedAt: string;
  status: TrustStatus;
  /** For foreign / invalid: why (e.g. "is writable by its group (mode 664)"). */
  reason?: string;
}

export function listTrust(): { trustFile: string; projects: TrustListEntry[] } {
  const store = loadTrust();
  const projects = Object.entries(store.projects).map(([file, rec]): TrustListEntry => {
    const entry = { file, workspace: rec.workspace, trustedAt: rec.trustedAt };
    if (!existsSync(file)) return { ...entry, status: "missing" };
    const check = inspectOwnedFile(file, true);
    if (check.reason) return { ...entry, status: "foreign", reason: check.reason };
    try {
      return { ...entry, status: parseProjectSettings(check.text ?? "", file).workspace === rec.workspace ? "ok" : "changed" };
    } catch (e) {
      return { ...entry, status: "invalid", reason: errorMessage(e) };
    }
  });
  return { trustFile: trustFilePath(), projects };
}

// ── Credential extraction from the Slack desktop app ─────

export interface TokenExtractionResult {
  tokens: string[];
  cookie: string | null;
  cookieError?: string;
}

const EXEC_TIMEOUT_MS = 15_000;
/** `security` may show a Keychain dialog the user has to find and click. */
const KEYCHAIN_TIMEOUT_MS = 120_000;

function getSlackDataDirs(): string[] {
  const home = homedir();
  if (platform() === "darwin") {
    return [
      join(home, "Library", "Application Support", "Slack"),
      // Mac App Store build
      join(home, "Library", "Containers", "com.tinyspeck.slackmacgap", "Data", "Library", "Application Support", "Slack"),
    ];
  }
  return [join(home, ".config", "Slack")];
}

export function extractTokensFromSlack(): TokenExtractionResult {
  if (platform() === "win32") {
    throw new SlackerError(
      withRunNote(
        "auth setup isn't supported on Windows (Slack encrypts its cookie with DPAPI). " +
          `Copy the xoxc token and the "d" cookie from Slack in a browser, then run: slacker auth add <name>`
      ),
      "extraction_failed"
    );
  }
  const results: TokenExtractionResult = { tokens: [], cookie: null };
  const keys = new KeyCache();

  for (const slackDir of getSlackDataDirs()) {
    const leveldbDir = join(slackDir, "Local Storage", "leveldb");
    if (existsSync(leveldbDir)) {
      for (const file of readdirSync(leveldbDir).filter((f) => f.endsWith(".ldb") || f.endsWith(".log"))) {
        try {
          const str = readFileSync(join(leveldbDir, file)).toString("utf-8");
          for (const m of str.matchAll(/xoxc-[a-zA-Z0-9._%-]+/g)) {
            if (!results.tokens.includes(m[0])) results.tokens.push(m[0]);
          }
        } catch {
          // skip unreadable files
        }
      }
    }

    if (!results.cookie) {
      for (const cookiesDb of [join(slackDir, "Cookies"), join(slackDir, "Network", "Cookies")]) {
        if (!existsSync(cookiesDb)) continue;
        try {
          results.cookie = decryptSlackCookie(cookiesDb, keys);
          if (results.cookie) break;
        } catch (e) {
          results.cookieError = (e as Error).message;
        }
      }
    }
  }

  return results;
}

interface DecryptionKey {
  key: Buffer;
  /** How the key was obtained, for error messages. */
  source: string;
}

const peanuts = (): Buffer => pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

function execError(e: unknown): { timedOut: boolean; missing: boolean; status?: number; stderr: string } {
  const err = e as { code?: string; signal?: string; status?: number; stderr?: Buffer | string };
  return {
    timedOut: err.code === "ETIMEDOUT" || err.signal === "SIGTERM",
    missing: err.code === "ENOENT",
    status: err.status,
    stderr: String(err.stderr ?? "").trim(),
  };
}

/** Resolve each key at most once per extraction (one Keychain prompt, not one per cookie DB). */
class KeyCache {
  private cache = new Map<string, DecryptionKey>();

  get(prefix: "v10" | "v11"): DecryptionKey {
    const id = platform() === "darwin" ? "darwin" : prefix;
    let key = this.cache.get(id);
    if (!key) {
      key = platform() === "darwin" ? macKey() : prefix === "v10" ? { key: peanuts(), source: "the default v10 key" } : linuxKeyringKey();
      this.cache.set(id, key);
    }
    return key;
  }
}

function macKey(): DecryptionKey {
  try {
    const password = execFileSync("security", ["find-generic-password", "-w", "-s", "Slack Safe Storage"], {
      encoding: "utf-8",
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { key: pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1"), source: "the Keychain" };
  } catch (e) {
    const err = execError(e);
    // 44 = errSecItemNotFound: Slack never stored a key, so Chromium used its built-in default.
    if (err.status === 44 || /could not be found/i.test(err.stderr)) {
      return { key: peanuts(), source: 'the default key (no "Slack Safe Storage" item in the Keychain)' };
    }
    const why = err.timedOut ? "timed out — the Keychain prompt may be hidden behind other windows" : err.stderr || "access denied";
    throw new SlackerError(
      withRunNote(
        `Could not read "Slack Safe Storage" from the macOS Keychain (${why}). ` +
          `Run the command again and click "Allow" or "Always Allow" when macOS asks, or add credentials by hand: slacker auth add <name>`
      ),
      "extraction_failed"
    );
  }
}

function linuxKeyringKey(): DecryptionKey {
  try {
    const password = execFileSync("secret-tool", ["lookup", "application", "Slack"], {
      encoding: "utf-8",
      timeout: EXEC_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (password) return { key: pbkdf2Sync(password, "saltysalt", 1, 16, "sha1"), source: "the keyring" };
  } catch (e) {
    const err = execError(e);
    if (err.missing) {
      throw new SlackerError(
        withRunNote(
          "Slack's cookie is encrypted with a keyring password (v11) and `secret-tool` isn't installed " +
            `(install libsecret-tools), or add credentials by hand: slacker auth add <name>`
        ),
        "extraction_failed"
      );
    }
    if (err.timedOut) throw new SlackerError("Timed out reading Slack's password from the keyring (is the keyring unlocked?).", "extraction_failed");
  }
  throw new SlackerError(
    withRunNote(
      "Slack's cookie is encrypted with a keyring password (v11) but none was found for Slack in the keyring. " +
        `Unlock the keyring and retry, or add credentials by hand: slacker auth add <name>`
    ),
    "extraction_failed"
  );
}

function decryptSlackCookie(dbPath: string, keys: KeyCache): string | null {
  let hex: string;
  try {
    hex = execFileSync(
      "sqlite3",
      [dbPath, "SELECT hex(encrypted_value) FROM cookies WHERE name='d' AND host_key='.slack.com' LIMIT 1;"],
      { encoding: "utf-8", timeout: EXEC_TIMEOUT_MS, stdio: ["ignore", "pipe", "pipe"] }
    ).trim();
  } catch (e) {
    const err = execError(e);
    if (err.missing) {
      throw new SlackerError(
        withRunNote("sqlite3 is required to read Slack's cookie database; install it, or add credentials by hand: slacker auth add <name>"),
        "extraction_failed"
      );
    }
    throw new SlackerError(`Could not read ${dbPath}: ${err.timedOut ? "sqlite3 timed out" : err.stderr || (e as Error).message}`, "extraction_failed");
  }
  if (!hex) return null;

  const encrypted = Buffer.from(hex, "hex");
  const prefix = encrypted.subarray(0, 3).toString("ascii");
  if (prefix !== "v10" && prefix !== "v11") return null;

  const { key, source } = keys.get(prefix);
  let decrypted: string;
  try {
    const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
    decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString("utf-8");
  } catch {
    throw new SlackerError(
      withRunNote(
        `Could not decrypt Slack's session cookie with ${source}. ` +
          `Add credentials by hand instead: slacker auth add <name>`
      ),
      "extraction_failed"
    );
  }
  const match = decrypted.match(/xoxd-[a-zA-Z0-9%_/+=.-]+/);
  return match ? match[0] : null;
}
