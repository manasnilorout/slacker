import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  linkSync,
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
import { dirname, isAbsolute, join, parse } from "node:path";
import { createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { withRunNote } from "./command.js";
import { SlackerError } from "./errors.js";
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
 * keeps its permission bits; a new one gets `mode`. Symlinks are written through.
 */
export function writeFileAtomic(file: string, data: string, mode = 0o644): void {
  const target = realTarget(file);
  let keep = mode;
  try {
    keep = statSync(target).mode & 0o777;
  } catch {
    // new file
  }
  replaceFile(target, data, keep);
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

function readProjectSettings(file: string): ProjectSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf-8"));
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

/** Find the nearest .slacker.json walking up from `start`. */
export function findProjectSettings(start = process.cwd()): { file: string; settings: ProjectSettings } | null {
  const seen = new Set<string>();
  for (const from of searchStarts(start)) {
    let dir = from;
    const { root } = parse(dir);
    while (!seen.has(dir)) {
      seen.add(dir);
      const file = join(dir, PROJECT_FILE);
      if (existsSync(file)) return { file, settings: readProjectSettings(file) };
      if (dir === root) break;
      dir = dirname(dir);
    }
  }
  return null;
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
}

/**
 * Decide which workspace to use. First match wins:
 * --workspace flag > SLACKER_WORKSPACE env > nearest .slacker.json > defaultWorkspace.
 * An invalid .slacker.json throws (`invalid_project_file`) — it may say `"readOnly": true` —
 * unless `ignoreInvalidProject` is set (callers that never write), which skips it and reports why.
 */
export function chooseWorkspace(flag?: string, cwd = process.cwd(), opts: { ignoreInvalidProject?: boolean } = {}): WorkspaceChoice {
  let project: ReturnType<typeof findProjectSettings> = null;
  let ignoredProjectError: string | undefined;
  try {
    project = findProjectSettings(cwd);
  } catch (e) {
    if (!(opts.ignoreInvalidProject && e instanceof SlackerError && e.code === "invalid_project_file")) throw e;
    ignoredProjectError = e.message;
  }
  const ignored = ignoredProjectError === undefined ? {} : { ignoredProjectError };
  const readOnly = project?.settings.readOnly === true || parseBoolEnv(process.env.SLACKER_READ_ONLY);
  const base = { projectFile: project?.file, readOnly, ...ignored };
  const env = process.env.SLACKER_WORKSPACE?.trim();
  const flagName = flag?.trim();
  if (flagName) return { ...base, name: flagName, source: "flag" };
  if (env) return { ...base, name: env, source: "env" };
  if (project?.settings.workspace) return { ...base, name: project.settings.workspace, source: "project" };
  return { ...base, source: "default" };
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
