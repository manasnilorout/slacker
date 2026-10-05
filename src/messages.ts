/**
 * User-facing texts shared by the CLI and the MCP server, so both explain identity problems and
 * misconfiguration the same way (and always with a runnable fix command). Commands are written as
 * plain `slacker …`; `withRunNote` adds one line saying how to run slacker when that differs.
 */
import { stripRunNote, withRunNote } from "./command.js";
import { quoteNames } from "./util.js";

const cmd = "slacker";

/** The team the credentials actually sign in to (auth.test). */
export interface LiveTeam {
  team: string;
  teamId: string;
}

export type IdentityCode = "workspace_alias" | "team_mismatch" | "team_unverified";

export interface IdentityProblem {
  code: IdentityCode;
  message: string;
  /** The CLI may write anyway with --allow-alias (never true for a team mismatch). */
  overridable: boolean;
}

/** Commands that clean up a duplicated config.json entry. */
export function aliasFixSteps(): string[] {
  return [`${cmd} auth list`, `${cmd} auth remove <name of the copy>`, `${cmd} auth setup`];
}

/** Other config.json names share this workspace's team, so one of them probably means something else. */
export function aliasWarning(workspace: string, aliases: string[], team: { name?: string; id?: string } = {}): string {
  const which = team.name ? `"${team.name}"${team.id ? ` (${team.id})` : ""}` : team.id ? `team ${team.id}` : "the same team";
  return withRunNote(
    `Workspace "${workspace}" shares its Slack team with ${quoteNames(aliases)} in config.json ` +
      `(${bothOrAll(aliases)} sign in to ${which}) — one is probably a copied entry, so a name may not mean the team you think. ` +
      `Writes are refused until config.json is fixed: ${aliasFixSteps().join(" → ")}.`
  );
}

/** "both" for two names (this one + one alias), "all" for more. */
const bothOrAll = (aliases: string[]) => (aliases.length > 1 ? "all" : "both");

const ALLOW_ALIAS = "To write anyway (CLI only) pass --allow-alias.";

/** Why a write from an aliased workspace is refused (`workspace_alias`). */
export function aliasRefusal(workspace: string, aliases: string[], team: string): string {
  const fix = `${cmd} auth list → ${cmd} auth remove <copy> → ${cmd} auth setup`;
  return withRunNote(
    `Workspace "${workspace}" shares credentials with ${quoteNames(aliases)} (${bothOrAll(aliases)} sign in to team "${team}"). ` +
      `Refusing to write until config.json is fixed: ${fix}. ${ALLOW_ALIAS}`
  );
}

/** Why a write from a workspace with no recorded teamId is refused (`team_unverified`). */
export function unverifiedRefusal(workspace: string): string {
  return withRunNote(
    `Workspace "${workspace}" has no teamId in config.json, so slacker can't verify which team its credentials sign in to. ` +
      `Refusing to write. Fix: ${cmd} auth setup (re-imports the workspace with its team). ${ALLOW_ALIAS}`
  );
}

/** Why a write is refused when the credentials sign in to another team (`team_mismatch`, never overridable). */
export function mismatchRefusal(workspace: string, configuredTeamId: string, live: LiveTeam): string {
  return withRunNote(
    `Workspace "${workspace}" is configured for team ${configuredTeamId} but its credentials sign in to "${live.team}" (${live.teamId}). ` +
      `Fix config.json: ${cmd} auth setup, or ${cmd} auth remove ${workspace}.`
  );
}

/** The credentials sign in to a different team than config.json records. */
export function teamMismatchWarning(workspace: string, configuredTeamId: string, live: LiveTeam): string {
  return withRunNote(
    `config.json says workspace "${workspace}" is team ${configuredTeamId}, but its credentials sign in to "${live.team}" (${live.teamId}). ` +
    `Writes are refused until config.json is fixed: ${cmd} auth setup, or ${cmd} auth remove ${workspace}.`
  );
}

/** config.json has no teamId for the workspace, so writes can't be checked against the live team. */
export function unverifiedWarning(workspace: string, live?: LiveTeam): string {
  return withRunNote(
    `Workspace "${workspace}" has no teamId in config.json, so slacker can't verify which team its credentials sign in to` +
    `${live ? ` (right now: "${live.team}", ${live.teamId})` : ""}. Writes are refused until it's fixed: ${cmd} auth setup.`
  );
}

/**
 * Everything wrong with a workspace's identity, most serious first. `live` is the auth.test
 * result when it's known (a mismatch can only be detected with it).
 */
export function identityProblems(ws: { name: string; teamId?: string }, aliases: string[], live?: LiveTeam): IdentityProblem[] {
  const problems: IdentityProblem[] = [];
  if (live && ws.teamId && live.teamId !== ws.teamId) {
    problems.push({ code: "team_mismatch", message: teamMismatchWarning(ws.name, ws.teamId, live), overridable: false });
  }
  if (aliases.length) {
    const team = live ? { name: live.team, id: live.teamId } : { id: ws.teamId };
    problems.push({ code: "workspace_alias", message: aliasWarning(ws.name, aliases, team), overridable: true });
  }
  if (!ws.teamId) problems.push({ code: "team_unverified", message: unverifiedWarning(ws.name, live), overridable: true });
  return problems;
}

// ── MCP degraded mode ────────────────────────────────────

export const NOT_CONFIGURED = "slacker is not configured:";
export const RESTART = "restart the MCP server (Claude Code: /mcp → reconnect)";
const NEXT_CALL = "takes effect on the next tool call — no restart needed";

const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/**
 * Why the server's workspace can't be resolved, and how to fix it. config.json is re-read on every
 * call, so fixing it needs no restart; changing the server's own arguments does. `available` is
 * undefined when config.json itself can't be read (the reason then says how to fix it).
 */
export function setupProblem(reason: string, available: string[] | undefined): string {
  const why = sentence(stripRunNote(reason));
  if (available === undefined) return withRunNote(`${why} Fixing config.json ${NEXT_CALL}.`);
  if (!available.length) {
    return withRunNote(`${why} To fix: run \`${cmd} auth setup\` (the Slack desktop app must be signed in); that ${NEXT_CALL}.`);
  }
  return withRunNote(
    `${why} To fix: run \`${cmd} auth list\` to see the workspaces. Fixing config.json ` +
    `(\`${cmd} auth setup\`, \`${cmd} auth default <name>\` or \`${cmd} auth rename <old> <new>\`) ${NEXT_CALL}. ` +
    `To point this server at another workspace instead, run \`${cmd} init <workspace> --mcp\` in your project ` +
    `(or correct --workspace in the MCP server config), then ${RESTART}.`
  );
}

/** A problem found while the server started (a corrupt .slacker.json): only a restart picks up the fix. */
export function startupProblem(reason: string): string {
  return withRunNote(`${sentence(stripRunNote(reason))} Fix it, then ${RESTART} — this was read at startup, so the fix needs a restart.`);
}
