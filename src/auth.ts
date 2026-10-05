import { existsSync, statSync } from "node:fs";
import { platform } from "node:os";
import { AuthTestResponse, SlackAPI } from "./api.js";
import {
  extractTokensFromSlack,
  findDuplicateTeams,
  loadConfig,
  putWorkspace,
  SlackCliConfig,
  TokenExtractionResult,
  updateConfig,
  validateWorkspaceName,
} from "./config.js";
import { withRunNote } from "./command.js";
import { SlackerError } from "./errors.js";
import { errorMessage, quoteNames } from "./util.js";

/** Commands in messages are written as plain `slacker …`; `withRunNote` adds how to run it when that differs. */
const cmd = "slacker";
const noted = (texts: string[]) => texts.map(withRunNote);

/** Injectable for tests (the real extractor reads the Slack desktop app's files and Keychain). */
export interface AuthDeps {
  extract?: () => TokenExtractionResult;
}

function slugify(team: string): string {
  return team
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const maskToken = (token: string) => `${token.slice(0, 10)}…`;

/** `base`, else `base-2`, `base-3`… — the first name not already in the config. */
function freeName(base: string, config: SlackCliConfig): string {
  if (!Object.hasOwn(config.workspaces, base)) return base;
  for (let i = 2; ; i++) if (!Object.hasOwn(config.workspaces, `${base}-${i}`)) return `${base}-${i}`;
}

function extractOrThrow(deps: AuthDeps, purpose: string): TokenExtractionResult & { cookie: string } {
  const extracted = (deps.extract ?? extractTokensFromSlack)();
  if (!extracted.tokens.length) throw new SlackerError("No xoxc tokens found. Is the Slack desktop app installed and signed in?", "no_tokens");
  if (!extracted.cookie) {
    throw new SlackerError(
      withRunNote(
        `Could not extract ${purpose} from Slack desktop: ${extracted.cookieError ?? "cookie not found"}. ` +
          `Add credentials by hand with: ${cmd} auth add <name>`
      ),
      "extraction_failed"
    );
  }
  return { ...extracted, cookie: extracted.cookie };
}

interface LiveToken {
  token: string;
  auth: AuthTestResponse;
}

/** auth.test every extracted token with the desktop cookie. */
async function verifyTokens(tokens: string[], cookie: string) {
  const live: LiveToken[] = [];
  const failures: Array<{ token: string; error: string }> = [];
  for (const token of tokens) {
    try {
      live.push({ token, auth: await new SlackAPI(token, cookie).authTest() });
    } catch (e) {
      failures.push({ token: maskToken(token), error: errorMessage(e) });
    }
  }
  return { live, failures };
}

export interface SetupWorkspaceResult {
  name: string;
  team: string;
  teamId: string;
  user: string;
  updated: boolean;
}

/** Notes about the default workspace after an add/setup, so a missing default is never a surprise. */
function defaultNotes(config: SlackCliConfig, before: string | null): string[] {
  const names = Object.keys(config.workspaces);
  if (!names.length) return [];
  if (!config.defaultWorkspace) {
    return [`No default workspace is set — pick one with: ${cmd} auth default <name> (available: ${names.join(", ")})`];
  }
  if (config.defaultWorkspace !== before) {
    return [`"${config.defaultWorkspace}" is now the default workspace. Change it with: ${cmd} auth default <name>`];
  }
  return [];
}

/**
 * Import every signed-in workspace from the Slack desktop app into config.json. An existing entry
 * is only ever updated by credentials for the same team; new teams never take over an existing name.
 * A default workspace is only chosen when the config had no workspaces before.
 */
export async function authSetup(file: string, deps: AuthDeps = {}) {
  const extracted = extractOrThrow(deps, "the Slack session cookie");
  const { live, failures } = await verifyTokens(extracted.tokens, extracted.cookie);

  const workspaces: SetupWorkspaceResult[] = [];
  const warnings: string[] = [];
  const notes = updateConfig(file, (config) => {
    const defaultBefore = config.defaultWorkspace;
    const claimed = new Set<string>(); // names already written in this run
    for (const { token, auth } of live) {
      const sameTeam = Object.keys(config.workspaces).filter((n) => config.workspaces[n].teamId === auth.team_id);
      const unclaimed = sameTeam.filter((n) => !claimed.has(n));
      const slug = slugify(auth.team) || auth.team_id.toLowerCase();

      let name: string;
      const sameUser = unclaimed.filter((n) => config.workspaces[n].userId === auth.user_id);
      const pool = sameUser.length ? sameUser : unclaimed;
      if (pool.length) {
        name = pool.includes(slug) ? slug : pool[0];
        const others = sameTeam.filter((n) => n !== name);
        if (others.length) {
          warnings.push(
            `${quoteNames([name, ...others])} all point at team "${auth.team}" (${auth.team_id}); only "${name}" was updated. ` +
              `If the others are copies, remove them with: ${cmd} auth remove <name>`
          );
        }
      } else {
        name = freeName(slug, config);
        if (name !== slug) {
          warnings.push(
            `"${slug}" is already taken by another entry, so "${auth.team}" (${auth.team_id}) was saved as "${name}". ` +
              `Rename it with: ${cmd} auth rename ${name} <new-name>`
          );
        }
      }

      const updated = Object.hasOwn(config.workspaces, name);
      putWorkspace(config, name, { token, cookie: extracted.cookie, url: auth.url, userId: auth.user_id, teamId: auth.team_id });
      claimed.add(name);
      workspaces.push({ name, team: auth.team, teamId: auth.team_id, user: auth.user, updated });
    }
    return { defaultWorkspace: config.defaultWorkspace, notes: defaultNotes(config, defaultBefore) };
  });
  return {
    config: file,
    tokensFound: extracted.tokens.length,
    workspaces,
    defaultWorkspace: notes.defaultWorkspace,
    warnings: noted(warnings),
    notes: noted(notes.notes),
    failures,
  };
}

/**
 * Re-extract tokens and the cookie from Slack desktop and update each config entry whose team (and
 * user) matches a live desktop session. Entries added by hand or from another session are left alone.
 */
export async function authRefresh(file: string, deps: AuthDeps = {}) {
  const extracted = extractOrThrow(deps, "a fresh session cookie");
  const { live, failures } = await verifyTokens(extracted.tokens, extracted.cookie);

  const refreshed: string[] = [];
  const untouched: Array<{ name: string; reason: string }> = [];
  // Unchanged configs aren't rewritten (updateConfig compares before saving).
  updateConfig(file, (config) => {
    for (const [name, ws] of Object.entries(config.workspaces)) {
      const sameTeam = live.filter((l) => l.auth.team_id === ws.teamId);
      const match = sameTeam.find((l) => l.auth.user_id === ws.userId) ?? (ws.userId ? undefined : sameTeam[0]);
      if (match) {
        ws.token = match.token;
        ws.cookie = extracted.cookie;
        ws.url = match.auth.url || ws.url;
        if (!ws.userId) ws.userId = match.auth.user_id;
        refreshed.push(name);
      } else if (sameTeam.length) {
        untouched.push({ name, reason: `Slack desktop is signed in to team ${ws.teamId} as a different user (${sameTeam[0].auth.user})` });
      } else {
        untouched.push({
          name,
          reason: ws.teamId
            ? `Slack desktop has no working session for team ${ws.teamId}; left unchanged`
            : "entry has no teamId to match; left unchanged",
        });
      }
    }
  });
  return { config: file, tokensFound: extracted.tokens.length, refreshed, untouched, failures };
}

export interface WorkspaceCheck {
  name: string;
  default: boolean;
  ok: boolean;
  team?: string;
  teamId?: string;
  user?: string;
  url: string;
  error?: string;
}

/** Verify every configured workspace live, flagging duplicates, team mismatches and loose permissions. */
export async function authList(file: string) {
  const config = loadConfig(file);
  const warnings: string[] = [];
  const workspaces: WorkspaceCheck[] = await Promise.all(
    Object.entries(config.workspaces).map(async ([name, ws]) => {
      const isDefault = config.defaultWorkspace === name;
      try {
        const auth = await new SlackAPI(ws.token, ws.cookie).authTest();
        if (ws.teamId && auth.team_id !== ws.teamId) {
          warnings.push(
            `Workspace "${name}" is configured for team ${ws.teamId} but its credentials sign in to "${auth.team}" (${auth.team_id}). ` +
              `Fix it with: ${cmd} auth remove ${name} && ${cmd} auth setup`
          );
        }
        return { name, default: isDefault, ok: true, team: auth.team, teamId: auth.team_id, user: auth.user, url: auth.url };
      } catch (e) {
        return { name, default: isDefault, ok: false, teamId: ws.teamId || undefined, url: ws.url, error: errorMessage(e) };
      }
    })
  );

  const duplicates = findDuplicateTeams(config);
  for (const names of duplicates) {
    warnings.push(
      `Workspaces ${quoteNames(names)} all point at the same Slack team (${config.workspaces[names[0]].teamId}). ` +
        `If one is a copy, remove it with: ${cmd} auth remove <name>`
    );
  }

  if (platform() !== "win32" && existsSync(file)) {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) {
      warnings.push(`${file} is readable by other users (mode ${mode.toString(8)}) and holds your Slack session. Fix: chmod 600 "${file}"`);
    }
  }

  return { config: file, workspaces, duplicates, warnings: noted(warnings) };
}

function assertExists(config: SlackCliConfig, name: string): void {
  if (!Object.hasOwn(config.workspaces, name)) {
    const available = Object.keys(config.workspaces);
    throw new SlackerError(`Workspace "${name}" not found. Available: ${available.length ? available.join(", ") : "(none)"}`, "workspace_not_found");
  }
}

export function authDefault(file: string, name: string) {
  updateConfig(file, (config) => {
    assertExists(config, name);
    config.defaultWorkspace = name;
  });
  return { defaultWorkspace: name };
}

/**
 * Add credentials by hand. Replacing an existing entry that belongs to a different team requires
 * `force`, so a typo'd name can't silently repoint a workspace.
 */
export async function authAdd(file: string, name: string, token: string, cookie: string, opts: { force?: boolean } = {}) {
  validateWorkspaceName(name);
  token = token.trim();
  cookie = cookie.trim().replace(/^d=/, "");
  if (!/^xox[a-z]-/.test(token)) {
    throw new SlackerError("The token should start with xoxc- (copy it from Slack in a browser or the desktop app).", "invalid_argument");
  }
  if (!cookie) throw new SlackerError('The cookie is empty; it is the value of Slack\'s "d" cookie (xoxd-…).', "invalid_argument");

  const auth = await new SlackAPI(token, cookie).authTest();
  return updateConfig(file, (config) => {
    const existing = Object.hasOwn(config.workspaces, name) ? config.workspaces[name] : undefined;
    if (existing?.teamId && existing.teamId !== auth.team_id && !opts.force) {
      throw new SlackerError(
        `Workspace "${name}" is already configured for team ${existing.teamId}, but these credentials sign in to "${auth.team}" (${auth.team_id}). ` +
          "Pick another name, or pass --force to replace it.",
        "workspace_exists"
      );
    }
    const warnings: string[] = [];
    const aliases = Object.keys(config.workspaces).filter((n) => n !== name && config.workspaces[n].teamId === auth.team_id);
    if (aliases.length) {
      warnings.push(`Team "${auth.team}" is also configured as ${quoteNames(aliases)}; you now have more than one name for it.`);
    }

    const defaultBefore = config.defaultWorkspace;
    putWorkspace(config, name, { token, cookie, url: auth.url, userId: auth.user_id, teamId: auth.team_id });
    return {
      workspace: name,
      team: auth.team,
      teamId: auth.team_id,
      user: auth.user,
      updated: !!existing,
      replaced: !!existing && existing.teamId !== auth.team_id,
      defaultWorkspace: config.defaultWorkspace,
      warnings,
      notes: noted(defaultNotes(config, defaultBefore)),
    };
  });
}

const pinnedNote = (name: string) =>
  `Projects pinned to "${name}" in .slacker.json or .mcp.json need updating (run ${cmd} init <workspace> there).`;

export function authRemove(file: string, name: string) {
  return updateConfig(file, (config) => {
    assertExists(config, name);
    delete config.workspaces[name];
    const notes: string[] = [];
    if (config.defaultWorkspace === name) {
      config.defaultWorkspace = null;
      const left = Object.keys(config.workspaces);
      notes.push(
        `"${name}" was the default workspace; no default is set now.` +
          (left.length ? ` Pick one with: ${cmd} auth default <name> (available: ${left.join(", ")})` : "")
      );
    }
    notes.push(pinnedNote(name));
    return { removed: name, defaultWorkspace: config.defaultWorkspace, notes: noted(notes) };
  });
}

export function authRename(file: string, oldName: string, newName: string) {
  return updateConfig(file, (config) => {
    assertExists(config, oldName);
    validateWorkspaceName(newName);
    if (newName === oldName) throw new SlackerError(`Workspace is already called "${oldName}".`, "invalid_argument");
    if (Object.hasOwn(config.workspaces, newName)) {
      throw new SlackerError(withRunNote(`Workspace "${newName}" already exists. Remove it first with: ${cmd} auth remove ${newName}`), "workspace_exists");
    }
    // Rebuild to keep the entry's position; fromEntries defines own properties (no __proto__ setter).
    config.workspaces = Object.fromEntries(
      Object.entries(config.workspaces).map(([n, ws]) => [n === oldName ? newName : n, ws])
    );
    if (config.defaultWorkspace === oldName) config.defaultWorkspace = newName;
    return { renamed: { from: oldName, to: newName }, defaultWorkspace: config.defaultWorkspace, notes: noted([pinnedNote(oldName)]) };
  });
}
