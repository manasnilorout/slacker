/**
 * Posting through Slack incoming webhooks as a "persona": a bot name and icon (an emoji or an image
 * URL), an optional default channel, and the webhook URL. Unlike everything else in slacker this
 * does NOT act as you and needs no slack-cli credentials, so it also works from an MCP config that
 * only sets SLACKER_WEBHOOK_URL (e.g. `npx -y github:manasnilorout/slacker serve --webhook-only`).
 *
 * Personas come from (first match wins):
 *   1. a persona named on the command line / in the tool call,
 *   2. SLACKER_WEBHOOK_PERSONA (a stored persona),
 *   3. SLACKER_WEBHOOK_URL (+ SLACKER_WEBHOOK_USERNAME / _ICON / _CHANNEL): an ad-hoc persona, handy
 *      in an MCP client's `env` block,
 *   4. the default persona of the workspace in use (-w, SLACKER_WORKSPACE or a trusted .slacker.json),
 *   5. the global default persona — but when a workspace is in use, only if it is on that workspace's
 *      team (so a post never silently lands in another Slack team).
 * Stored personas live in ~/.config/slacker/webhooks.json (SLACKER_WEBHOOKS_FILE overrides), 0600:
 * a webhook URL is a secret (anyone holding it can post), so it never goes in argv or in output.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { formatDuration } from "./api.js";
import { stripRunNote, withRunNote } from "./command.js";
import {
  inspectOwnedFile,
  loadConfig,
  parseBoolEnv,
  PROJECT_FILE,
  projectWriteBlock,
  updatePrivateJson,
  validateWorkspaceName,
  WorkspaceChoice,
} from "./config.js";
import { SlackerError } from "./errors.js";
import { Surface } from "./messages.js";
import { isPlainObject, quoteNames } from "./util.js";

export const WEBHOOK_ENV = {
  url: "SLACKER_WEBHOOK_URL",
  username: "SLACKER_WEBHOOK_USERNAME",
  icon: "SLACKER_WEBHOOK_ICON",
  channel: "SLACKER_WEBHOOK_CHANNEL",
  persona: "SLACKER_WEBHOOK_PERSONA",
  file: "SLACKER_WEBHOOKS_FILE",
} as const;

/** The name results use for the persona built from SLACKER_WEBHOOK_URL (reserved: can't be stored). */
export const ENV_PERSONA = "env";

/** Slack truncates longer messages; refuse instead of posting half of one. */
export const MAX_WEBHOOK_TEXT = 40_000;
const MAX_USERNAME = 80;
const DEFAULT_TIMEOUT_MS = 15_000;

export function webhookFilePath(): string {
  return process.env[WEBHOOK_ENV.file] || join(homedir(), ".config", "slacker", "webhooks.json");
}

// ── Validation ───────────────────────────────────────────

const WEBHOOK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const WEBHOOK_PATH = /^\/services\/([TE][A-Z0-9]+)\/(B[A-Z0-9]+)\/([A-Za-z0-9_-]+)$/;
const EXPECTED_URL = "https://hooks.slack.com/services/T…/B…/…";

export interface ParsedWebhook {
  url: string;
  /** The Slack team the webhook posts into (T…). */
  teamId: string;
  /** The webhook's own ID (B…). */
  hookId: string;
}

/** Check a Slack incoming webhook URL. Errors never repeat the URL: it is a secret. */
export function parseWebhookUrl(raw: string): ParsedWebhook {
  const bad = (why: string) => new SlackerError(`That isn't a Slack incoming webhook URL (${why}). Expected ${EXPECTED_URL}`, "invalid_webhook_url");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw bad("not a URL");
  }
  if (u.protocol !== "https:") throw bad("must start with https://");
  if (!WEBHOOK_HOSTS.has(u.hostname) || u.port || u.username || u.password) throw bad(`host must be ${[...WEBHOOK_HOSTS].join(" or ")}`);
  if (u.search || u.hash) throw bad("unexpected ? or # part");
  const m = WEBHOOK_PATH.exec(u.pathname);
  if (!m) throw bad("path must be /services/T…/B…/<secret>");
  // Rebuilt rather than u.href, which keeps an empty trailing "?" or "#".
  return { url: `https://${u.hostname}${u.pathname}`, teamId: m[1], hookId: m[2] };
}

/** `https://hooks.slack.com/services/T…/B…/••••`: safe to print (the secret part is hidden). */
export function redactWebhookUrl(url: string): string {
  try {
    const { teamId, hookId } = parseWebhookUrl(url);
    return `https://${new URL(url).hostname}/services/${teamId}/${hookId}/••••`;
  } catch {
    return "(invalid webhook URL)";
  }
}

/** Anything that mentions a webhook host is treated as a secret pasted in the wrong place. */
const looksLikeWebhook = (s: string) => /hooks\.slack(-gov)?\.com/i.test(s);

/** Refuse (without echoing it) a webhook URL given where a name, channel or icon was expected. */
function refuseWebhookIn(value: string, where: string): void {
  if (looksLikeWebhook(value)) {
    throw new SlackerError(
      `That ${where} looks like a webhook URL. Webhook URLs are secrets, so slacker never takes them as arguments: ` +
        "paste it at the prompt of `slacker webhook add <persona>`, or pipe it in on stdin. If it was exposed, regenerate it in Slack.",
      "secret_in_argv"
    );
  }
}

const PERSONA_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validatePersonaName(name: string): void {
  refuseWebhookIn(name, "persona name");
  if (!PERSONA_NAME.test(name)) {
    throw new SlackerError(
      `Invalid persona name "${name}": use up to 64 letters, digits, ".", "_" or "-" (starting with a letter or digit).`,
      "invalid_persona_name"
    );
  }
  if (name === ENV_PERSONA) throw new SlackerError(`"${ENV_PERSONA}" is reserved for the persona from ${WEBHOOK_ENV.url}; pick another name.`, "invalid_persona_name");
}

/** A workspace label (same rules as config.json names). */
function validateLabel(name: string): void {
  refuseWebhookIn(name, "workspace name");
  validateWorkspaceName(name);
}

/** C0 and C1 controls, plus bidi overrides/isolates/marks: Slack would get them verbatim. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

/** The bot name shown on the message. */
export function normalizeUsername(raw: string): string {
  const v = raw.trim();
  if (!v) throw new SlackerError("The bot name can't be empty.", "invalid_argument");
  refuseWebhookIn(v, "bot name");
  if (UNSAFE_CHARS.test(v)) throw new SlackerError("The bot name can't contain control characters, line breaks or bidi overrides.", "invalid_argument");
  if ([...v].length > MAX_USERNAME) throw new SlackerError(`The bot name can be at most ${MAX_USERNAME} characters.`, "invalid_argument");
  return v;
}

/** `robot_face`, `:robot_face:`, `+1` → `:robot_face:` (icon_emoji); an http(s) URL is kept as an image (icon_url). */
export function normalizeIcon(raw: string): string {
  const v = raw.trim();
  refuseWebhookIn(v, "icon");
  if (/^https?:\/\//i.test(v)) {
    try {
      return new URL(v).href;
    } catch {
      throw new SlackerError("Invalid icon URL.", "invalid_argument");
    }
  }
  const m = /^:?((?:[a-z0-9][a-z0-9_+'-]*|[+-]1)(?:::skin-tone-[2-6])?):?$/i.exec(v);
  if (!m || UNSAFE_CHARS.test(v)) {
    throw new SlackerError(`Invalid icon "${v}": use a Slack emoji name like robot_face or :robot_face: (not the emoji character), or an image URL.`, "invalid_argument");
  }
  return `:${m[1].toLowerCase()}:`;
}

/** `general` → `#general` (bare names are channels, as everywhere in slacker); `#x`, `@user` and IDs are kept. */
export function normalizeChannel(raw: string): string {
  const v = raw.trim();
  refuseWebhookIn(v, "channel");
  if (!v || /\s/.test(v) || UNSAFE_CHARS.test(v) || /[<>]/.test(v) || v === "#" || v === "@") {
    throw new SlackerError(`Invalid channel "${v}": use #channel, a bare channel name, @user or a conversation ID.`, "invalid_argument");
  }
  if (/^@(here|channel|everyone)$/i.test(v)) {
    throw new SlackerError(`"${v}" is a mention, not a destination: use a #channel, a conversation ID or @user (mention it in the text instead).`, "invalid_argument");
  }
  if (/^[#@]/.test(v) || /^[CGDUW][A-Z0-9]{8,}$/.test(v)) return v;
  return `#${v}`;
}

const isEmoji = (icon: string) => icon.startsWith(":");

// ── The persona store ────────────────────────────────────

export interface Persona {
  url: string;
  /** Bot name shown on the message. */
  username?: string;
  /** `:emoji:` or an image URL. */
  icon?: string;
  /** Default channel; without one the webhook posts to its own channel. */
  channel?: string;
  /** Workspace label (a config.json name, usually detected from the webhook's team). */
  workspace?: string;
  /** Keys written by newer versions are kept on save. */
  [key: string]: unknown;
}

export interface WebhookStore {
  version: 1;
  defaultPersona: string | null;
  /** Workspace name → its default persona. */
  workspaceDefaults: Record<string, string>;
  personas: Record<string, Persona>;
  [key: string]: unknown;
}

const emptyStore = (): WebhookStore => ({ version: 1, defaultPersona: null, workspaceDefaults: {}, personas: {} });

/**
 * The persona store (empty when the file doesn't exist). One someone else could have written (same
 * ownership/mode checks as the trust file) is refused: it could send your posts somewhere else.
 */
export function loadWebhooks(file = webhookFilePath()): WebhookStore {
  if (!existsSync(file)) return emptyStore();
  const check = inspectOwnedFile(file, true);
  if (check.reason) {
    throw new SlackerError(
      `Refusing to use the webhook file ${file}: it ${check.reason}, so someone else could change where your posts go. Fix it (${check.fix ?? `chmod 600 ${file}`}).`,
      "invalid_webhook_file"
    );
  }
  const bad = (why: string) =>
    new SlackerError(
      withRunNote(`Invalid webhook file ${file}: ${why}. Fix it by hand, or delete it and add your personas again with: slacker webhook add <persona>`),
      "invalid_webhook_file"
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(check.text ?? "");
  } catch (e) {
    // JSON.parse quotes the text around the error, which may be part of a webhook URL: keep only where.
    const at = /position \d+(?: \(line \d+ column \d+\))?/.exec(e instanceof Error ? e.message : "");
    throw bad(`not valid JSON${at ? ` (at ${at[0]})` : ""}`);
  }
  if (!isPlainObject(parsed)) throw bad("expected a JSON object");
  const personas = parsed.personas ?? {};
  if (!isPlainObject(personas)) throw bad(`"personas" must be an object`);
  for (const [name, p] of Object.entries(personas)) {
    if (!PERSONA_NAME.test(name) || name === ENV_PERSONA || looksLikeWebhook(name)) throw bad(`a persona has an invalid or reserved name`);
    if (!isPlainObject(p)) throw bad(`persona "${name}" must be an object`);
    if (typeof p.url !== "string") throw bad(`persona "${name}" is missing a string "url"`);
    try {
      parseWebhookUrl(p.url);
    } catch {
      throw bad(`persona "${name}" has an invalid "url" (expected ${EXPECTED_URL})`);
    }
    for (const key of ["username", "icon", "channel", "workspace"]) {
      if (p[key] !== undefined && typeof p[key] !== "string") throw bad(`persona "${name}" has a non-string "${key}"`);
    }
  }
  const def = parsed.defaultPersona ?? null;
  if (def !== null && typeof def !== "string") throw bad(`"defaultPersona" must be a string or null`);
  const wsDefaults = parsed.workspaceDefaults ?? {};
  if (!isPlainObject(wsDefaults) || Object.values(wsDefaults).some((v) => typeof v !== "string")) {
    throw bad(`"workspaceDefaults" must map workspace names to persona names`);
  }
  return {
    ...parsed,
    version: 1,
    defaultPersona: def,
    workspaceDefaults: wsDefaults as Record<string, string>,
    personas: personas as Record<string, Persona>,
  };
}

function updateWebhooks<R>(mutate: (store: WebhookStore) => R, file = webhookFilePath()): R {
  return updatePrivateJson(file, loadWebhooks, mutate);
}

function personaNotFound(name: string, store: WebhookStore, file: string): SlackerError {
  refuseWebhookIn(name, "persona name");
  const names = Object.keys(store.personas);
  return new SlackerError(
    withRunNote(
      `No webhook persona "${name}" in ${file}. ${names.length ? `Available: ${quoteNames(names)}.` : "There are none yet."} ` +
        "Add one with: slacker webhook add <persona> --username <bot name> --icon <emoji>"
    ),
    "persona_not_found"
  );
}

/** config.json workspaces whose team is `teamId` (none when config.json is missing or unreadable). */
function workspacesForTeam(teamId: string, configFile?: string): string[] {
  try {
    return Object.entries(loadConfig(configFile).workspaces)
      .filter(([, ws]) => ws.teamId === teamId)
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** The teamId config.json records for `workspace`, if any. */
function configTeamId(workspace: string, configFile?: string): string | undefined {
  try {
    const config = loadConfig(configFile);
    return Object.hasOwn(config.workspaces, workspace) ? config.workspaces[workspace].teamId || undefined : undefined;
  } catch {
    return undefined;
  }
}

function teamMismatch(teamId: string, workspace: string, recorded: string, fix: string): SlackerError {
  return new SlackerError(`This webhook posts into Slack team ${teamId}, but workspace "${workspace}" in config.json is team ${recorded}. ${fix}`, "team_mismatch");
}

export interface PersonaFields {
  name: string;
  /** For the fields below: undefined keeps the current value, "" removes it. */
  username?: string;
  icon?: string;
  channel?: string;
  workspace?: string;
}

/** Check and normalize everything `webhook add` takes except the URL (so the CLI can fail before asking for it). */
export function validatePersonaFields(input: PersonaFields): PersonaFields {
  validatePersonaName(input.name);
  const clean = (v: string | undefined, fn: (s: string) => string) => (v === undefined ? undefined : v.trim() === "" ? "" : fn(v));
  const workspace = input.workspace === undefined ? undefined : input.workspace.trim();
  if (workspace) validateLabel(workspace);
  return {
    name: input.name,
    username: clean(input.username, normalizeUsername),
    icon: clean(input.icon, normalizeIcon),
    channel: clean(input.channel, normalizeChannel),
    workspace,
  };
}

export interface AddPersonaInput extends PersonaFields {
  /** Required for a new persona; omit to keep an existing persona's URL. */
  url?: string;
  /** Save even though the webhook's team isn't the team config.json has for the workspace. */
  force?: boolean;
}

export interface AddPersonaResult {
  persona: string;
  action: "added" | "updated";
  /** An existing persona got a different webhook URL. */
  urlChanged: boolean;
  username: string | null;
  icon: string | null;
  channel: string | null;
  workspace: string | null;
  /** The workspace was picked because exactly one config.json workspace is the webhook's team. */
  workspaceDetected: boolean;
  teamId: string;
  webhook: string;
  isDefault: boolean;
  isWorkspaceDefault: boolean;
  /** This call made it the global default (the first persona added becomes it). */
  becameDefault: boolean;
  /** This call made it its workspace's default (the first persona for a workspace becomes it). */
  becameWorkspaceDefault: boolean;
  file: string;
}

/** `webhook add`: add a persona, or update one (fields not given are kept). */
export function addPersona(input: AddPersonaInput, opts: { configFile?: string; file?: string } = {}): AddPersonaResult {
  const file = opts.file ?? webhookFilePath();
  const fields = validatePersonaFields(input);
  const parsed = input.url !== undefined ? parseWebhookUrl(input.url) : undefined;

  return updateWebhooks((store) => {
    const existing = Object.hasOwn(store.personas, input.name) ? store.personas[input.name] : undefined;
    if (!existing && !parsed) throw new SlackerError(`Persona "${input.name}" doesn't exist yet, so it needs a webhook URL.`, "invalid_argument");
    const url = parsed?.url ?? existing!.url;
    const { teamId } = parseWebhookUrl(url);

    // undefined keeps the label, "" removes it; a new persona's label is detected from config.json.
    let workspace = fields.workspace === undefined ? existing?.workspace : fields.workspace || undefined;
    let workspaceDetected = false;
    if (!existing && fields.workspace === undefined) {
      const matches = workspacesForTeam(teamId, opts.configFile);
      if (matches.length === 1) [workspace, workspaceDetected] = [matches[0], true];
    }
    const oldWorkspace = existing?.workspace;
    const labelChanged = !!existing && oldWorkspace !== workspace;
    // Checked for a new persona and whenever the URL or the label changes, so a new URL can't keep another
    // team's label (a mismatch saved earlier with --force isn't re-asked on every update).
    const recorded = workspace ? configTeamId(workspace, opts.configFile) : undefined;
    const mismatch = !!workspace && !!recorded && recorded !== teamId;
    if (mismatch && (!existing || existing.url !== url || labelChanged) && !input.force) {
      throw teamMismatch(teamId, workspace!, recorded!, "Check the webhook URL and the workspace (-w), or pass --force to save it anyway.");
    }

    const next: Persona = { ...existing, url };
    for (const key of ["username", "icon", "channel"] as const) {
      const value = fields[key];
      if (value === undefined) continue;
      if (value === "") delete next[key];
      else next[key] = value;
    }
    if (workspace) next.workspace = workspace;
    else delete next.workspace;
    store.personas[input.name] = next;

    // Defaults: only set automatically for a new persona (or a new label), never brought back on an update,
    // and never for a label on another team (saved with --force): that would make -w post into the wrong team.
    if (labelChanged && oldWorkspace && store.workspaceDefaults[oldWorkspace] === input.name) delete store.workspaceDefaults[oldWorkspace];
    let becameDefault = false;
    let becameWorkspaceDefault = false;
    if (!existing && !store.defaultPersona) [store.defaultPersona, becameDefault] = [input.name, true];
    if (workspace && !mismatch && (!existing || labelChanged) && !Object.hasOwn(store.workspaceDefaults, workspace)) {
      store.workspaceDefaults[workspace] = input.name;
      becameWorkspaceDefault = true;
    }

    return {
      persona: input.name,
      action: existing ? "updated" : "added",
      urlChanged: !!existing && existing.url !== url,
      username: next.username ?? null,
      icon: next.icon ?? null,
      channel: next.channel ?? null,
      workspace: next.workspace ?? null,
      workspaceDetected,
      teamId,
      webhook: redactWebhookUrl(url),
      isDefault: store.defaultPersona === input.name,
      isWorkspaceDefault: !!workspace && store.workspaceDefaults[workspace] === input.name,
      becameDefault,
      becameWorkspaceDefault,
      file,
    };
  }, file);
}

export interface RemovePersonaResult {
  removed: string;
  defaultPersona: string | null;
  /** Workspaces this persona was the default for. */
  clearedWorkspaceDefaults: string[];
  file: string;
}

export function removePersona(name: string, file = webhookFilePath()): RemovePersonaResult {
  return updateWebhooks((store) => {
    if (!Object.hasOwn(store.personas, name)) throw personaNotFound(name, store, file);
    delete store.personas[name];
    if (store.defaultPersona === name) store.defaultPersona = null;
    const cleared = Object.entries(store.workspaceDefaults)
      .filter(([, p]) => p === name)
      .map(([ws]) => ws);
    for (const ws of cleared) delete store.workspaceDefaults[ws];
    return { removed: name, defaultPersona: store.defaultPersona, clearedWorkspaceDefaults: cleared, file };
  }, file);
}

export interface DefaultPersonaResult {
  /** The persona now the default, or null after --unset. */
  persona: string | null;
  /** The workspace whose default changed, or null for the global default. */
  workspace: string | null;
  previous: string | null;
}

/**
 * `webhook default`: set (or with persona null, unset) the global default, or a workspace's default.
 * A workspace default must be on that workspace's team when config.json knows it.
 */
export function setDefaultPersona(persona: string | null, workspace?: string, opts: { configFile?: string; file?: string } = {}): DefaultPersonaResult {
  const file = opts.file ?? webhookFilePath();
  const ws = workspace?.trim() || undefined;
  if (ws) validateLabel(ws);
  return updateWebhooks((store) => {
    if (persona !== null && !Object.hasOwn(store.personas, persona)) throw personaNotFound(persona, store, file);
    if (ws) {
      if (persona !== null) {
        const teamId = parseWebhookUrl(store.personas[persona].url).teamId;
        const recorded = configTeamId(ws, opts.configFile);
        if (recorded && recorded !== teamId) throw teamMismatch(teamId, ws, recorded, "Pick a persona on that team.");
      }
      const previous = Object.hasOwn(store.workspaceDefaults, ws) ? store.workspaceDefaults[ws] : null;
      if (persona === null) delete store.workspaceDefaults[ws];
      else store.workspaceDefaults[ws] = persona;
      return { persona, workspace: ws, previous };
    }
    const previous = store.defaultPersona;
    store.defaultPersona = persona;
    return { persona, workspace: null, previous };
  }, file);
}

export interface PersonaSummary {
  name: string;
  username: string | null;
  icon: string | null;
  channel: string | null;
  workspace: string | null;
  teamId: string;
  /** The URL with its secret part hidden. */
  webhook: string;
  isDefault: boolean;
  /** Workspaces this persona is the default for. */
  defaultFor: string[];
}

export interface PersonaList {
  file: string;
  personas: PersonaSummary[];
  /** The persona SLACKER_WEBHOOK_URL defines, when it's set. */
  env: Omit<PersonaSummary, "isDefault" | "defaultFor" | "workspace"> | null;
  /** SLACKER_WEBHOOK_PERSONA, when set: used when no persona is named. */
  envPersona: string | null;
}

/** Everything `webhook list` and the list_webhook_personas tool show (never a full URL). */
export function listPersonas(file = webhookFilePath()): PersonaList {
  const store = loadWebhooks(file);
  const personas = Object.entries(store.personas).map(
    ([name, p]): PersonaSummary => ({
      name,
      username: p.username ?? null,
      icon: p.icon ?? null,
      channel: p.channel ?? null,
      workspace: p.workspace ?? null,
      teamId: parseWebhookUrl(p.url).teamId,
      webhook: redactWebhookUrl(p.url),
      isDefault: store.defaultPersona === name,
      defaultFor: Object.entries(store.workspaceDefaults)
        .filter(([, d]) => d === name)
        .map(([ws]) => ws),
    })
  );
  let env: PersonaList["env"] = null;
  if (process.env[WEBHOOK_ENV.url]?.trim()) {
    const p = envPersona();
    env = { name: ENV_PERSONA, username: p.username ?? null, icon: p.icon ?? null, channel: p.channel ?? null, teamId: p.teamId, webhook: redactWebhookUrl(p.url) };
  }
  return { file, personas, env, envPersona: process.env[WEBHOOK_ENV.persona]?.trim() || null };
}

// ── Choosing a persona ───────────────────────────────────

export type PersonaSource = "named" | "env_persona" | "env_url" | "workspace_default" | "default";

export interface ResolvedPersona {
  name: string;
  source: PersonaSource;
  url: string;
  teamId: string;
  username?: string;
  icon?: string;
  channel?: string;
  workspace?: string;
}

export interface PersonaRequest {
  /** A stored persona, by name. */
  persona?: string;
  /** The workspace in use, for its default persona. */
  workspace?: string;
  /** Per-message overrides of the persona's bot name, icon and channel. */
  username?: string;
  icon?: string;
  channel?: string;
}

/** The ad-hoc persona from SLACKER_WEBHOOK_URL and friends (an error names the variable at fault). */
function envPersona(): ResolvedPersona {
  const named = <T>(name: string, fn: () => T): T => {
    try {
      return fn();
    } catch (e) {
      const err = e instanceof SlackerError ? e : new SlackerError(String(e), "invalid_argument");
      throw new SlackerError(`${name}: ${err.message}`, err.code);
    }
  };
  const { url, teamId } = named(WEBHOOK_ENV.url, () => parseWebhookUrl(process.env[WEBHOOK_ENV.url] ?? ""));
  const opt = (key: "username" | "icon" | "channel", fn: (s: string) => string) => {
    const v = process.env[WEBHOOK_ENV[key]]?.trim();
    return v ? named(WEBHOOK_ENV[key], () => fn(v)) : undefined;
  };
  return {
    name: ENV_PERSONA,
    source: "env_url",
    url,
    teamId,
    username: opt("username", normalizeUsername),
    icon: opt("icon", normalizeIcon),
    channel: opt("channel", normalizeChannel),
  };
}

function storedPersona(name: string, source: PersonaSource, store: WebhookStore, file: string): ResolvedPersona {
  if (!Object.hasOwn(store.personas, name)) throw personaNotFound(name, store, file);
  const p = store.personas[name];
  return {
    name,
    source,
    url: p.url,
    teamId: parseWebhookUrl(p.url).teamId,
    ...(p.username && { username: p.username }),
    ...(p.icon && { icon: p.icon }),
    ...(p.channel && { channel: p.channel }),
    ...(p.workspace && { workspace: p.workspace }),
  };
}

/**
 * The global default, when no persona was named. With a workspace in use that has no default of its
 * own, the global default is used only when it is provably on that workspace's team (its label, or
 * config.json's teamId): a post must never land in another Slack team just because a default exists.
 */
function fallbackPersona(store: WebhookStore, file: string, ws: string | undefined, configFile?: string): ResolvedPersona {
  if (!store.defaultPersona) {
    const names = Object.keys(store.personas);
    throw new SlackerError(
      withRunNote(
        names.length
          ? `No webhook persona given and no default set${ws ? ` (for workspace "${ws}" or globally)` : ""}. Available: ${quoteNames(names)}. ` +
              `Name one, or set a default with: slacker webhook default <persona>${ws ? ` -w ${ws}` : ""}`
          : `No webhook personas configured. Add one with: slacker webhook add <persona> --username <bot name> --icon <emoji> ` +
              `(or set ${WEBHOOK_ENV.url}, e.g. in your MCP client's env)`
      ),
      "no_persona"
    );
  }
  const p = storedPersona(store.defaultPersona, "default", store, file);
  if (!ws || p.workspace === ws) return p;
  const wsTeam = configTeamId(ws, configFile);
  if (wsTeam && wsTeam === p.teamId) return { ...p, workspace: ws };
  const why = wsTeam ? `but workspace "${ws}" is team ${wsTeam}` : `and slacker can't tell which team workspace "${ws}" is`;
  throw new SlackerError(
    withRunNote(
      `Workspace "${ws}" has no default webhook persona, and the global default "${p.name}" posts into team ${p.teamId}, ${why}. ` +
        `Name a persona, or set one for this workspace: slacker webhook default <persona> -w ${ws}`
    ),
    "no_persona"
  );
}

/** Pick the persona for a post (see the order at the top of this file) and apply the overrides. */
export function resolvePersona(req: PersonaRequest = {}, opts: { file?: string; configFile?: string } = {}): ResolvedPersona {
  const file = opts.file ?? webhookFilePath();
  // Validate the overrides first, so a typo fails before anything is looked up.
  const overrides = {
    ...(req.username?.trim() && { username: normalizeUsername(req.username) }),
    ...(req.icon?.trim() && { icon: normalizeIcon(req.icon) }),
    ...(req.channel?.trim() && { channel: normalizeChannel(req.channel) }),
  };
  const named = req.persona?.trim();
  const fromEnv = process.env[WEBHOOK_ENV.persona]?.trim();
  let base: ResolvedPersona;
  if (named) base = storedPersona(named, "named", loadWebhooks(file), file);
  else if (fromEnv) base = storedPersona(fromEnv, "env_persona", loadWebhooks(file), file);
  else if (process.env[WEBHOOK_ENV.url]?.trim()) base = envPersona();
  else {
    const store = loadWebhooks(file);
    const ws = req.workspace?.trim() || undefined;
    if (ws && Object.hasOwn(store.workspaceDefaults, ws)) base = storedPersona(store.workspaceDefaults[ws], "workspace_default", store, file);
    else base = fallbackPersona(store, file, ws, opts.configFile);
  }
  return { ...base, ...overrides };
}

/** The workspace whose default persona applies: one named with -w / SLACKER_WORKSPACE, or by a trusted .slacker.json. */
export function webhookWorkspace(choice: WorkspaceChoice): string | undefined {
  if (choice.source === "flag" || choice.source === "env") return choice.name;
  if (choice.source === "project" && choice.projectTrusted) return choice.name;
  return undefined;
}

/**
 * Whether choosing the persona for `req` can depend on the workspace (and so on a .slacker.json):
 * not when a persona is named, or SLACKER_WEBHOOK_PERSONA / SLACKER_WEBHOOK_URL decides it.
 */
export function personaUsesWorkspace(req: Pick<PersonaRequest, "persona">): boolean {
  return !req.persona?.trim() && !process.env[WEBHOOK_ENV.persona]?.trim() && !process.env[WEBHOOK_ENV.url]?.trim();
}

/**
 * Why a webhook post must be refused right now, with the same rules as every other write:
 * - a .slacker.json someone else controls (it might say read-only) — always, dry runs too;
 * - a .slacker.json you haven't trusted choosing the workspace — dry runs too, but only when that
 *   workspace would pick the persona (`usesWorkspace`): a named persona or SLACKER_WEBHOOK_URL
 *   doesn't depend on the file, and webhook-only users may not have the workspace to trust;
 * - a read-only project / SLACKER_READ_ONLY — real posts only (a dry run still works).
 */
export function webhookWriteBlock(
  choice: WorkspaceChoice,
  surface: Surface = "cli",
  opts: { dryRun?: boolean; usesWorkspace?: boolean } = {}
): SlackerError | undefined {
  if (choice.foreignProject || opts.usesWorkspace !== false) {
    const project = projectWriteBlock(choice, surface);
    if (project) {
      if (choice.foreignProject) return project;
      const name = surface === "mcp" ? "the persona parameter" : "-p/--persona";
      return new SlackerError(
        withRunNote(`${stripRunNote(project.message)} Or name the persona to post as (${name}): that doesn't depend on ${PROJECT_FILE}.`),
        project.code,
        project.hint
      );
    }
  }
  if (choice.readOnly && !opts.dryRun) {
    const why = choice.projectFile && !parseBoolEnv(process.env.SLACKER_READ_ONLY) ? `"readOnly": true in ${choice.projectFile}` : "SLACKER_READ_ONLY is set";
    return new SlackerError(`Refusing to post: this project is read-only (${why}).`, "read_only");
  }
  return undefined;
}

// ── Posting ──────────────────────────────────────────────

export interface WebhookSendOptions {
  /** Check everything and report where it would go, without posting. */
  dryRun?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface WebhookSendResult {
  dryRun: boolean;
  persona: string;
  source: PersonaSource;
  username: string | null;
  icon: string | null;
  /** null: the webhook's own channel. */
  channel: string | null;
  teamId: string;
  workspace: string | null;
  webhook: string;
  /** Present on a dry run: the text that would be posted. */
  text?: string;
}

const NOT_SENT = " — the message was NOT posted.";
const MAYBE_SENT = " — the message may or may not have been posted; check the channel before retrying.";
const REVOKED = "This webhook was removed or disabled in Slack. Create a new one, then run: slacker webhook add <persona>";

const WEBHOOK_HINTS: Record<string, string> = {
  invalid_token: REVOKED,
  no_service: REVOKED,
  no_service_id: REVOKED,
  no_team: REVOKED,
  team_disabled: REVOKED,
  no_active_hooks: REVOKED,
  channel_not_found:
    "The channel doesn't exist, or this webhook can't post there (a webhook created by a Slack app only posts to the channel picked when it was added).",
  channel_is_archived: "The channel is archived.",
  user_not_found: "No such @user to post to.",
  action_prohibited: "A workspace admin has restricted this webhook.",
  posting_to_general_channel_denied: "Only some members may post in this workspace's #general.",
  invalid_payload: "Slack couldn't read the message.",
  no_text: "The message text is empty.",
  too_many_attachments: "Too many attachments.",
  rate_limited: "Slack is rate limiting this webhook (about one message per second); wait a moment and try again.",
};

/** Network errors that prove the request never reached Slack (nothing sent before the connection or TLS handshake failed). */
const NOT_SENT_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function causeCode(e: unknown): string | undefined {
  for (let cur: unknown = e, depth = 0; cur && depth < 5; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

function payloadFor(p: ResolvedPersona, text: string): Record<string, string> {
  return {
    text,
    ...(p.username && { username: p.username }),
    ...(p.icon && (isEmoji(p.icon) ? { icon_emoji: p.icon } : { icon_url: p.icon })),
    ...(p.channel && { channel: p.channel }),
  };
}

/** Post `text` as persona `p`. Never retried: a webhook post has no idempotency key, so a retry could post twice. */
export async function sendWebhook(p: ResolvedPersona, text: string, opts: WebhookSendOptions = {}): Promise<WebhookSendResult> {
  if (!text.trim()) throw new SlackerError("The message text is empty.", "invalid_argument");
  if (text.length > MAX_WEBHOOK_TEXT) throw new SlackerError(`The message is longer than ${MAX_WEBHOOK_TEXT} characters; Slack would cut it off.`, "invalid_argument");
  const result: WebhookSendResult = {
    dryRun: !!opts.dryRun,
    persona: p.name,
    source: p.source,
    username: p.username ?? null,
    icon: p.icon ?? null,
    channel: p.channel ?? null,
    teamId: p.teamId,
    workspace: p.workspace ?? null,
    webhook: redactWebhookUrl(p.url),
  };
  if (opts.dryRun) return { ...result, text };
  if (opts.signal?.aborted) throw new SlackerError(`Cancelled before posting to the webhook${NOT_SENT}`, "network_error");

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(p.url, {
      method: "POST",
      headers: { "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(payloadFor(p, text)),
      redirect: "error",
      signal,
    });
  } catch (e) {
    // The URL is a secret: report the cause code, never the error's own text (it may contain the request).
    const code = causeCode(e);
    const why = timeout.aborted ? `timed out after ${formatDuration(timeoutMs)}` : opts.signal?.aborted ? "aborted" : (code ?? "the request failed");
    throw new SlackerError(`Network error posting to the webhook: ${why}${code && NOT_SENT_CODES.has(code) ? NOT_SENT : MAYBE_SENT}`, "network_error");
  }
  const body = (await res.text().catch(() => "")).trim();
  if (res.ok) return result;

  // Slack answers with a bare error code; anything else is shown only as the HTTP status.
  const code = /^[a-z][a-z0-9_]{1,60}$/.test(body) ? body : res.status === 429 ? "rate_limited" : `http_${res.status}`;
  const hint = WEBHOOK_HINTS[code];
  const outcome = res.status >= 500 ? MAYBE_SENT : NOT_SENT;
  const message = `Slack rejected the webhook post (HTTP ${res.status}): ${code}${hint ? ` — ${hint}` : ""}${outcome}`;
  // Only the revoked-webhook hint names a command: add how to run slacker when that differs.
  throw new SlackerError(hint === REVOKED ? withRunNote(message) : message, code, hint === REVOKED ? withRunNote(hint) : hint);
}
