/**
 * `slacker init`: pin a project to a workspace (.slacker.json) and/or register the MCP server in
 * .mcp.json, after checking that config.json can vouch for the workspace's team.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isAuthError } from "./api.js";
import { entryPath, stripRunNote, withRunNote } from "./command.js";
import {
  DEFAULT_CONFIG_FILE,
  inspectOwnedFile,
  PROJECT_FILE,
  ProjectSettingsSchema,
  recordTrust,
  resolveWorkspace,
  teamAliases,
  trustedWorkspace,
  trustFilePath,
  trustKey,
  WorkspaceSource,
  writeFileAtomic,
} from "./config.js";
import { SlackerError } from "./errors.js";
import { identityProblems, LiveTeam, untrustedInitRefusal } from "./messages.js";
import { supportedNode } from "./node-check.js";
import { dim, green, printWarnings, red, sanitizeForTerminal, shellQuote, yellow } from "./output.js";
import { SlackSession } from "./session.js";
import { errorMessage, formatIssues, isPlainObject } from "./util.js";

export interface InitOpts {
  mcp?: boolean;
  mcpOnly?: boolean;
  name?: string;
  readOnly?: boolean;
  allowAlias?: boolean;
  replace?: boolean;
  /** Hidden: both --allow-alias and --replace (what --force meant before they were split). */
  force?: boolean;
  command?: string;
  node?: string;
}

/** What init needs from the CLI around it. */
export interface InitEnv {
  /** config.json in use (-c / SLACKER_CONFIG / default). */
  configFile: string;
  /** The project directory (.slacker.json and .mcp.json are written here). */
  cwd: string;
  /** The global -w/--workspace value, if any. */
  workspaceFlag?: string;
  /** The node running slacker (what .mcp.json runs by default). */
  execPath: string;
  /** Where to look for a node outside nvm. */
  nodeCandidates: readonly string[];
}

interface McpServerEntry {
  command: string;
  args: string[];
}

export interface InitResult {
  projectFile: string | null;
  /** Where trust for projectFile was recorded (so its workspace may be used for CLI writes); null with --mcp-only. */
  trustFile: string | null;
  workspace: string;
  readOnly: boolean;
  mcpFile: string | null;
  servers: Array<{ name: string; workspace: string; readOnly: boolean; replaced: boolean } & McpServerEntry>;
  /** Stale .mcp.json entries removed with --replace. */
  removed: string[];
  /** Exactly what --allow-alias / --replace / --force overrode. */
  overridden: string[];
  /** Workspaces whose credentials Slack rejected during the live check. */
  credentialErrors: string[];
  claudeMcpAdd: string[];
  warnings: string[];
}

/** What init may override: --allow-alias, --replace, or the hidden --force (both). Records each use. */
class Overrides {
  readonly done: string[] = [];
  constructor(private readonly o: InitOpts) {}
  get allowAlias(): boolean {
    return !!(this.o.allowAlias || this.o.force);
  }
  get replace(): boolean {
    return !!(this.o.replace || this.o.force);
  }
  record(kind: "allowAlias" | "replace", what: string): void {
    const flag = this.o[kind] ? (kind === "allowAlias" ? "--allow-alias" : "--replace") : "--force";
    this.done.push(`${flag}: ${what}`);
  }
}

/**
 * init writes into the project directory, which may be an untrusted clone: refuse a project file that
 * is a symlink leading outside the (real) project directory — init would otherwise parse, merge into
 * and rewrite whatever it points at (~/.claude.json, config.json …) — or that isn't a regular file.
 * A symlink that stays inside the project is fine. A missing file is fine (it will be created).
 */
function assertSafeProjectPath(file: string, realCwd: string): void {
  let link;
  try {
    link = lstatSync(file);
  } catch {
    return; // doesn't exist
  }
  if (!link.isSymbolicLink()) {
    if (!link.isFile()) throw new SlackerError(`${file} is not a regular file. Move it aside, then rerun init. Nothing was written.`, "invalid_file");
    return;
  }
  let target: string;
  try {
    target = realpathSync(file);
  } catch {
    throw new SlackerError(
      `${file} is a symlink whose target doesn't exist, so init can't check where it leads. Remove the link, then rerun init. Nothing was written.`,
      "unsafe_symlink"
    );
  }
  const rel = relative(realCwd, target);
  // "..real.json" is a file in the project; only ".." itself or "../…" climbs out.
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SlackerError(
      `${file} is a symlink to ${target}, outside this project (${realCwd}). Refusing to read or rewrite it. ` +
        `Remove the link (or replace it with a regular file), then rerun init. Nothing was written.`,
      "unsafe_symlink"
    );
  }
  if (!statSync(target).isFile()) {
    throw new SlackerError(`${file} is a symlink to ${target}, which is not a regular file. Nothing was written.`, "unsafe_symlink");
  }
}

/** Parse an existing JSON object file, naming the file in any error (undefined when it doesn't exist). */
function readJsonObject(file: string, what: string): Record<string, unknown> | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf-8"));
  } catch (e) {
    throw new SlackerError(`Could not parse ${file}: ${errorMessage(e)}.`, "invalid_file");
  }
  if (!isPlainObject(parsed)) throw new SlackerError(`${file} must contain a JSON object (${what}).`, "invalid_file");
  return parsed;
}

/**
 * The existing .slacker.json, raw (so unknown keys survive the rewrite) but validated with the same
 * schema the CLI and server use — init must not merge into a file they would reject. With
 * --mcp-only the file isn't written, so an invalid one is left alone with a warning instead.
 */
function readProjectFile(file: string, o: InitOpts, ov: Overrides, warnings: string[]): Record<string, unknown> {
  try {
    const project = readJsonObject(file, `{"workspace": "<name>"}`);
    if (!project) return {};
    const check = ProjectSettingsSchema.safeParse(project);
    if (!check.success) {
      throw new SlackerError(
        `Invalid ${file}: ${formatIssues(check.error.issues)}. Expected {"workspace": "<name>", "readOnly": true|false}.`,
        "invalid_file"
      );
    }
    return project;
  } catch (e) {
    if (o.mcpOnly) {
      warnings.push(
        `${errorMessage(e)} It was left untouched (--mcp-only). The MCP server reads it at startup, so a server started ` +
          `from this directory starts degraded (every tool returns this error) until you fix it or rerun init without --mcp-only.`
      );
      return {};
    }
    if (!ov.replace) {
      throw new SlackerError(`${errorMessage(e)} Fix it or move it aside, then rerun init (or pass --replace to overwrite it). Nothing was written.`, "invalid_file");
    }
    ov.record("replace", `overwrote ${file}, which was invalid (${errorMessage(e)})`);
    return {};
  }
}

function realpathOrUndefined(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Absolute path of the `slacker` executable on PATH when it is this very install (e.g. via npm link). */
function slackerOnPath(cwd: string): string | undefined {
  const entry = realpathOrUndefined(entryPath());
  if (!entry) return undefined;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const bin = dir && resolve(cwd, dir, "slacker");
    if (bin && realpathOrUndefined(bin) === entry) return bin;
  }
  return undefined;
}

/** `slacker`, `slacker.cmd` … — a command that is slacker itself (no entry path needed). */
function isSlackerCommandName(command: string): boolean {
  return /^slacker(\.(cmd|exe))?$/i.test(basename(command));
}

/** Does this string point at a slacker install (our entry, any slacker checkout's dist, or the npm package)? */
function pointsAtSlacker(s: string): boolean {
  return s === entryPath() || s.includes("@manasnilorout/slacker") || /(^|[\\/])slacker[\\/]+dist[\\/]+index\.js$/.test(s);
}

/** An .mcp.json entry init may overwrite: `… serve --workspace …` run by slacker. */
function isSlackerEntry(entry: unknown): entry is { command?: unknown; args: string[] } {
  if (!isPlainObject(entry) || !Array.isArray(entry.args)) return false;
  const args = entry.args.filter((a): a is string => typeof a === "string");
  if (!args.includes("serve") || !args.includes("--workspace")) return false;
  const command = typeof entry.command === "string" ? entry.command : "";
  return isSlackerCommandName(command) || pointsAtSlacker(command) || args.some(pointsAtSlacker);
}

function entryWorkspace(entry: { args: string[] }): string | undefined {
  const i = entry.args.indexOf("--workspace");
  return i >= 0 ? entry.args[i + 1] : undefined;
}

/** Stable (non-nvm) places to look for node when the current one is nvm-managed. */
export const STABLE_NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

/** `node -v` of an executable ("v24.1.0"), or undefined when it can't be run. */
function nodeVersion(node: string): string | undefined {
  try {
    const out = execFileSync(node, ["-v"], { timeout: 5000, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^v\d+\.\d+\.\d+/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

/** The first candidate node outside nvm that is new enough. */
function findStableNode(candidates: readonly string[]): { path: string; version: string } | undefined {
  for (const path of candidates) {
    const real = realpathOrUndefined(path);
    if (!real || real.includes("/.nvm/")) continue;
    const version = nodeVersion(path);
    if (version && supportedNode(version)) return { path, version };
  }
  return undefined;
}

function nvmWarning(what: string, env: InitEnv): string {
  const stable = findStableNode(env.nodeCandidates);
  const fix = stable
    ? `Use a Node that doesn't move instead: rerun init with --node ${stable.path} (${stable.version}).`
    : "Install Node 22.12+ outside nvm (e.g. Homebrew), then rerun init with --node <path to that node>.";
  return (
    `${what} is pinned to one nvm Node version, so the MCP server breaks when you switch or upgrade Node. ${fix} ` +
    "(npm link under nvm is pinned the same way: the linked slacker lives in that version's bin directory.)"
  );
}

/**
 * The command (and entry-path prefix) .mcp.json runs: --node, --command, the absolute path of the
 * slacker on PATH (MCP clients started from a GUI often lack your shell's PATH), or this node.
 */
function launchCommand(o: InitOpts, env: InitEnv, warnings: string[]): { command: string; prefix: string[] } {
  const entry = [entryPath()];
  if (o.node !== undefined) {
    const node = resolve(env.cwd, o.node);
    if (!existsSync(node)) throw new SlackerError(`--node ${o.node}: no such file. Give the path of a node executable. Nothing was written.`, "invalid_argument");
    const version = nodeVersion(node);
    if (!version) warnings.push(`Could not run ${node} -v to check its version; slacker needs Node 22.12 or newer.`);
    else if (!supportedNode(version)) warnings.push(`${node} is Node ${version}, but slacker needs Node 22.12 or newer.`);
    return { command: node, prefix: entry };
  }
  if (o.command !== undefined) return { command: o.command, prefix: isSlackerCommandName(o.command) ? [] : entry };
  const onPath = slackerOnPath(env.cwd);
  if (onPath) {
    const real = realpathOrUndefined(onPath) ?? onPath;
    if (onPath.includes("/.nvm/") || real.includes("/.nvm/")) warnings.push(nvmWarning(`The slacker on your PATH (${onPath})`, env));
    return { command: onPath, prefix: [] };
  }
  if (env.execPath.includes("/.nvm/")) warnings.push(nvmWarning(`.mcp.json will run ${env.execPath}, which`, env));
  return { command: env.execPath, prefix: entry };
}

/**
 * D3 check before pinning a project to a workspace: no aliases, a recorded teamId, and credentials
 * that sign in to it. A failed live check never blocks init (it may be offline); rejected
 * credentials are reported loudly with the fix.
 */
async function checkWorkspaceIdentity(name: string, file: string, ov: Overrides, out: { warnings: string[]; credentialErrors: string[] }) {
  const ws = resolveWorkspace(name, file);
  const aliases = teamAliases(name, file);
  let live: LiveTeam | undefined;
  try {
    live = await new SlackSession(name, file, { api: { timeoutMs: 10_000, maxRetries: 1 } }).whoami();
  } catch (e) {
    if (isAuthError(e)) {
      out.credentialErrors.push(
        withRunNote(`Slack rejected the credentials for workspace "${name}": ${stripRunNote(e.message)} The project is set up anyway, but slacker can't use "${name}" until that's fixed.`)
      );
    } else {
      out.warnings.push(`Could not verify workspace "${name}" with Slack (${errorMessage(e)}); continuing with config.json as it is.`);
    }
  }
  const problems = identityProblems(ws, aliases, live);
  if (!problems.length) return;
  const text = problems.map((p) => stripRunNote(p.message)).join(" ");
  if (!ov.allowAlias) {
    throw new SlackerError(withRunNote(`${text} Nothing was written. Fix config.json first, or pass --allow-alias to pin "${name}" anyway.`), problems[0].code);
  }
  ov.record("allowAlias", withRunNote(`pinned "${name}" anyway. ${text}`));
}

/**
 * D1: bare `init` must not trust a workspace it took from a .slacker.json you never trusted for it (a
 * cloned repo's file would otherwise trust itself). Refuses (`untrusted_project`) unless the file is
 * yours and already trusted for that workspace; nothing has been written yet when this runs.
 */
function assertTrustedFallback(fallback: { name?: string; source: WorkspaceSource; projectFile?: string }, o: InitOpts): void {
  if (fallback.source !== "project" || !fallback.projectFile || !fallback.name) return;
  const file = fallback.projectFile;
  const foreign = inspectOwnedFile(file).reason;
  let detail = foreign ? `: it ${foreign}` : "";
  if (!foreign) {
    let recorded: string | undefined;
    try {
      recorded = trustedWorkspace(trustKey(file));
    } catch (e) {
      detail = ` (the trust record couldn't be read: ${errorMessage(e)})`;
    }
    if (recorded === fallback.name) return;
    if (recorded !== undefined) detail = ` (you trusted it for workspace "${recorded}")`;
  }
  const args = o.mcpOnly ? " --mcp-only" : o.mcp ? " --mcp" : "";
  throw new SlackerError(untrustedInitRefusal(file, fallback.name, detail, args), "untrusted_project", withRunNote(`slacker init ${fallback.name}${args}`));
}

/** The workspace init pins when none is named: --workspace, SLACKER_WORKSPACE, .slacker.json, defaultWorkspace. */
function fallbackWorkspace(env: InitEnv, project: Record<string, unknown>, projectFile: string): { name?: string; source: WorkspaceSource; projectFile?: string } {
  const flag = env.workspaceFlag?.trim();
  if (flag) return { name: flag, source: "flag" };
  const fromEnv = process.env.SLACKER_WORKSPACE?.trim();
  if (fromEnv) return { name: fromEnv, source: "env" };
  const pinned = typeof project.workspace === "string" ? project.workspace.trim() : "";
  if (pinned) return { name: pinned, source: "project", projectFile };
  return { source: "default" };
}

export async function initProject(names: string[], o: InitOpts, env: InitEnv): Promise<InitResult> {
  const file = env.configFile;
  const { cwd } = env;
  const projectFile = join(cwd, PROJECT_FILE);
  const mcpFile = join(cwd, ".mcp.json");
  const mcp = !!(o.mcp || o.mcpOnly);
  // Both files are checked before either is read, and again right before writing (the live check below can take a while).
  const realCwd = realpathSync(cwd);
  const checkPaths = () => {
    assertSafeProjectPath(projectFile, realCwd);
    if (mcp) assertSafeProjectPath(mcpFile, realCwd);
  };
  checkPaths();
  const ov = new Overrides(o);
  const warnings: string[] = [];
  const credentialErrors: string[] = [];

  // Everything that needs no network is checked first, so a bad flag never waits on Slack.
  if (o.node !== undefined && o.command !== undefined) throw new SlackerError("Use --node or --command, not both.", "invalid_argument");
  if (!mcp && (o.node !== undefined || o.command !== undefined)) {
    warnings.push(`${o.node !== undefined ? "--node" : "--command"} only changes the .mcp.json entry, so it was ignored without --mcp or --mcp-only.`);
  }

  const project = readProjectFile(projectFile, o, ov, warnings);
  const fallback = fallbackWorkspace(env, project, projectFile);
  if (!names.length) assertTrustedFallback(fallback, o);
  const workspaces = [...new Set(names.length ? names : [resolveWorkspace(fallback.name, file, fallback).name])];
  for (const name of workspaces) resolveWorkspace(name, file); // validates every name
  if (workspaces.length > 1 && !mcp) throw new SlackerError(`Several workspaces only make sense with --mcp (${PROJECT_FILE} pins one).`, "invalid_argument");
  if (o.name !== undefined && workspaces.length > 1) {
    throw new SlackerError("--name works with a single workspace; with several, servers are named slacker-<workspace>.", "invalid_argument");
  }

  const readOnly = o.readOnly ?? project.readOnly === true;

  // Validate .mcp.json completely (and plan its entries) before the live check and before writing anything.
  let mcpJson: Record<string, unknown> = {};
  let existingServers: Record<string, unknown> = {};
  const servers: InitResult["servers"] = [];
  const removed: string[] = [];
  if (mcp) {
    const { command, prefix } = launchCommand(o, env, warnings);
    try {
      mcpJson = readJsonObject(mcpFile, `{"mcpServers": {…}}`) ?? {};
    } catch (e) {
      throw new SlackerError(`${errorMessage(e)} Fix it or move it aside, then rerun init. Nothing was written.`, "invalid_file");
    }
    if (mcpJson.mcpServers !== undefined) {
      if (!isPlainObject(mcpJson.mcpServers)) {
        throw new SlackerError(`"mcpServers" in ${mcpFile} must be an object mapping server names to entries. Fix it, then rerun init. Nothing was written.`, "invalid_file");
      }
      existingServers = { ...mcpJson.mcpServers };
    }

    const configArgs = file === DEFAULT_CONFIG_FILE ? [] : ["--config", resolve(file)];

    for (const ws of workspaces) {
      const name = workspaces.length > 1 ? `slacker-${ws}` : (o.name ?? "slacker");
      const existing = Object.hasOwn(existingServers, name) ? existingServers[name] : undefined;
      if (existing !== undefined && !isSlackerEntry(existing)) {
        if (!ov.replace) {
          throw new SlackerError(
            `${mcpFile} already has a server named "${name}" that isn't slacker. Pick another --name, or pass --replace to overwrite it. Nothing was written.`,
            "mcp_entry_exists"
          );
        }
        const was = isPlainObject(existing) && typeof existing.command === "string" ? ` (it ran ${existing.command})` : "";
        ov.record("replace", `overwrote the non-slacker server "${name}" in ${mcpFile}${was}`);
      }
      // A rerun without --read-only/--no-read-only keeps what the existing entry had.
      const wasReadOnly = isSlackerEntry(existing) && existing.args.includes("--read-only");
      const entryReadOnly = o.readOnly ?? (readOnly || wasReadOnly);
      servers.push({
        name,
        workspace: ws,
        command,
        args: [...prefix, "serve", "--workspace", ws, ...configArgs, ...(entryReadOnly ? ["--read-only"] : [])],
        readOnly: entryReadOnly,
        replaced: existing !== undefined,
      });
    }

    // Moving from one server to one per workspace: an older plain "slacker" entry would also start.
    const plain = existingServers.slacker;
    if (workspaces.length > 1 && isSlackerEntry(plain)) {
      const ws = entryWorkspace(plain);
      if (ws && workspaces.includes(ws)) {
        if (ov.replace) {
          delete existingServers.slacker;
          removed.push("slacker");
          ov.record("replace", `removed the older "slacker" server for workspace "${ws}" (now "slacker-${ws}")`);
        } else {
          warnings.push(
            `${mcpFile} still has an older "slacker" server for workspace "${ws}", next to the new "slacker-${ws}", so the client would start both. ` +
              `Delete it from .mcp.json, or rerun this init with --replace to remove it.`
          );
        }
      }
    }
  }

  for (const name of workspaces) await checkWorkspaceIdentity(name, file, ov, { warnings, credentialErrors });

  checkPaths();
  let trustFile: string | null = null;
  if (!o.mcpOnly) {
    const next: Record<string, unknown> = { ...project, workspace: workspaces[0] };
    if (o.readOnly !== undefined) next.readOnly = o.readOnly;
    // Never group/world-writable: such a .slacker.json isn't trusted (another user could change it).
    writeFileAtomic(projectFile, JSON.stringify(next, null, 2) + "\n", 0o644, { clearBits: 0o022 });
  }
  if (mcp) {
    const entries = Object.fromEntries(servers.map((s) => [s.name, { command: s.command, args: s.args }]));
    writeFileAtomic(mcpFile, JSON.stringify({ ...mcpJson, mcpServers: { ...existingServers, ...entries } }, null, 2) + "\n");
  }
  if (!o.mcpOnly) {
    // You chose this workspace for this project: let the file choose it for CLI writes too.
    recordTrust(trustKey(projectFile), workspaces[0]);
    trustFile = trustFilePath();
  }

  return {
    projectFile: o.mcpOnly ? null : projectFile,
    trustFile,
    workspace: workspaces[0],
    readOnly,
    mcpFile: mcp ? mcpFile : null,
    servers,
    removed,
    overridden: ov.done,
    credentialErrors,
    claudeMcpAdd: servers.map((s) => ["claude", "mcp", "add", "--scope", "local", s.name, "--", s.command, ...s.args].map(shellQuote).join(" ")),
    warnings,
  };
}

export function printInit(r: InitResult, o: InitOpts, configFile: string) {
  if (r.projectFile) {
    const ws = resolveWorkspace(r.workspace, configFile);
    const url = sanitizeForTerminal(ws.url);
    console.log(green(`✓ Wrote ${PROJECT_FILE}`) + dim(` → workspace "${r.workspace}" (${url})${r.readOnly ? " · read-only" : ""} · trusted on this machine`));
  }
  for (const s of r.servers) {
    console.log(green(`✓ ${s.replaced ? "Updated" : "Registered"} "${s.name}" in .mcp.json`) + dim(` → workspace "${s.workspace}"${s.readOnly ? " · read-only" : ""}`));
  }
  for (const name of r.removed) console.log(green(`✓ Removed "${name}" from .mcp.json`));
  for (const e of r.credentialErrors) console.log(red(`✗ ${e}`));
  for (const line of r.overridden) console.log(yellow(`Overridden — ${line}`));
  if (o.force && !r.overridden.length) console.log(dim("--force: nothing needed overriding."));
  printWarnings(r.warnings);
  if (r.servers.length) {
    console.log();
    console.log(dim(".mcp.json written this way is personal (machine-specific paths and your workspace names): keep it out of git,"));
    console.log(dim("or skip it and register the server for just you in Claude Code instead:"));
    for (const line of r.claudeMcpAdd) console.log(`  ${line}`);
    console.log(dim("Claude Code asks you to approve project MCP servers on its next start; check them with /mcp."));
  } else {
    console.log(dim("Add --mcp to also register the slacker MCP server in .mcp.json."));
  }
}
