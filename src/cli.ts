import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { createInterface } from "node:readline/promises";
import { SlackApiError, SlackNetworkError } from "./api.js";
import { authAdd, authDefault, authList, authRefresh, authRemove, authRename, authSetup } from "./auth.js";
import { setActiveConfig, stripRunNote, withRunNote } from "./command.js";
import { chooseWorkspace, configPath, parseBoolEnv, PROJECT_FILE, WorkspaceChoice } from "./config.js";
import { SlackerError } from "./errors.js";
import { initProject, InitOpts, printInit, STABLE_NODE_CANDIDATES } from "./init.js";
import { IdentityProblem, identityProblems, LiveTeam } from "./messages.js";
import { startServer } from "./server.js";
import { SlackSession } from "./session.js";
import {
  bold,
  cyan,
  destinationLine,
  dim,
  green,
  localTime,
  plural,
  printJson,
  printMessages,
  printNote,
  printNotes,
  printTable,
  printWarnings,
  yellow,
} from "./output.js";
import { errorMessage } from "./util.js";
import { VERSION } from "./version.js";

interface GlobalOpts {
  workspace?: string;
  config?: string;
  json?: boolean;
}

/** What the CLI reads from its environment (injectable for tests). */
export interface CliIO {
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?(mode: boolean): unknown };
  cwd: string;
  /** Set by main() under --json: commander's own error text is suppressed and main prints JSON instead. */
  jsonErrors: boolean;
  /** The node running slacker (what init writes into .mcp.json by default). */
  execPath: string;
  /** Where init looks for a node outside nvm. */
  nodeCandidates: readonly string[];
}

/** Commands that change something in Slack (status only with --set/--clear). */
const WRITE_COMMANDS = new Set(["send", "edit", "delete", "react"]);

/**
 * Per-command context. The workspace choice is made lazily so commands that don't need one
 * (auth …, init) never read .slacker.json — a corrupt project file can't block fixing config.json.
 */
class Context {
  private _choice?: WorkspaceChoice;
  private _session?: SlackSession;

  constructor(
    readonly cmd: Command,
    readonly io: CliIO
  ) {}

  get opts(): GlobalOpts {
    return this.cmd.optsWithGlobals<GlobalOpts>();
  }

  get file(): string {
    return configPath(this.opts.config);
  }

  /** send/edit/delete/react, and status --set/--clear. */
  get isWrite(): boolean {
    const name = this.cmd.name();
    if (WRITE_COMMANDS.has(name)) return true;
    const o = this.cmd.opts<{ set?: string; clear?: boolean }>();
    return name === "status" && (o.set !== undefined || !!o.clear);
  }

  /**
   * An invalid .slacker.json fails write commands closed (it may say read-only). Commands that
   * never write skip it with a warning when they don't need its workspace: auth commands always,
   * read commands when -w or SLACKER_WORKSPACE names the workspace.
   */
  get choice(): WorkspaceChoice {
    if (!this._choice) {
      const named = !!(this.opts.workspace?.trim() || process.env.SLACKER_WORKSPACE?.trim());
      const lenient = this.cmd.parent?.name() === "auth" || (named && !this.isWrite);
      this._choice = chooseWorkspace(this.opts.workspace, this.io.cwd, { ignoreInvalidProject: lenient });
      const ignored = this._choice.ignoredProjectError;
      if (ignored) {
        console.error(
          yellow(`Warning: ${withRunNote(`${stripRunNote(ignored)} Ignored for this command; write commands refuse to run until it's fixed.`)}`)
        );
      }
    }
    return this._choice;
  }

  get session(): SlackSession {
    return (this._session ??= new SlackSession(this.choice.name, this.file, { source: this.choice }));
  }

  /** Writes are refused when the project's .slacker.json (or SLACKER_READ_ONLY) says read-only. */
  assertWritable(): void {
    const { readOnly, projectFile } = this.choice;
    if (!readOnly) return;
    const why = projectFile && !parseBoolEnv(process.env.SLACKER_READ_ONLY) ? `"readOnly": true in ${projectFile}` : "SLACKER_READ_ONLY is set";
    throw new SlackerError(`Refusing to write: this project is read-only (${why}).`, "read_only");
  }
}

// ── Input helpers ─────────────────────────────────────────

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

const QUOTE_HINT = {
  send: 'Quote the message: slacker send general "your message" (use -- before text that starts with -)',
  edit: 'Quote the message: slacker edit <message link> "new text" (use -- before text that starts with -)',
};

/**
 * The single text argument of send/edit. Extra words mean the text wasn't quoted (and options inside
 * it may already have been taken as flags), so refuse. "-" — and only "-" — reads stdin.
 */
async function messageText(ctx: Context, text: string, verb: "send" | "edit"): Promise<string> {
  if (ctx.cmd.args.length > 2) throw new SlackerError(QUOTE_HINT[verb], "unquoted_text");
  if (text !== "-") return text;
  if (ctx.io.stdin.isTTY) {
    throw new SlackerError(`Text "-" reads the message from stdin, but stdin is a terminal. Pipe it in: echo "hi" | slacker ${verb} <target> -`, "invalid_argument");
  }
  const piped = (await readAll(ctx.io.stdin)).replace(/\r\n/g, "\n").replace(/\n+$/, "");
  if (!piped.trim()) throw new SlackerError("Message text from stdin is empty.", "invalid_argument");
  return piped;
}

async function confirm(io: CliIO, question: string): Promise<boolean> {
  const rl = createInterface({ input: io.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/** Ask each question on stderr and read answers from a TTY in raw mode, so nothing is echoed. */
function promptHidden(io: CliIO, questions: string[]): Promise<string[]> {
  const input = io.stdin;
  if (!input.setRawMode) throw new SlackerError("Can't read secrets without echo from this terminal. Set SLACK_TOKEN and SLACK_COOKIE instead.", "no_tty");
  const answers: string[] = [];
  let current = "";
  process.stderr.write(questions[0]);
  input.setRawMode(true);
  input.setEncoding("utf-8");
  input.resume();
  return new Promise((resolvePromise, reject) => {
    const finish = (error?: Error) => {
      input.off("data", onData);
      input.setRawMode?.(false);
      input.pause();
      if (error) reject(error);
      else resolvePromise(answers);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of String(chunk)) {
        if (ch === "\u0003") {
          process.stderr.write("\n");
          return finish(new SlackerError("Cancelled.", "cancelled"));
        }
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          process.stderr.write("\n");
          answers.push(current.trim());
          current = "";
          if (answers.length === questions.length) return finish();
          process.stderr.write(questions[answers.length]);
        } else if (ch === "\u007f" || ch === "\b") {
          current = current.slice(0, -1);
        } else if (ch >= " ") {
          current += ch;
        }
      }
    };
    input.on("data", onData);
  });
}

/** Token and cookie for `auth add`: env vars, else a hidden prompt, else two lines of piped stdin. */
async function readSecrets(io: CliIO): Promise<{ token: string; cookie: string }> {
  const token = process.env.SLACK_TOKEN?.trim();
  const cookie = process.env.SLACK_COOKIE?.trim();
  if (token || cookie) {
    if (!token || !cookie) throw new SlackerError("Set both SLACK_TOKEN and SLACK_COOKIE, or neither to be prompted.", "invalid_argument");
    return { token, cookie };
  }
  if (io.stdin.isTTY) {
    const [t, c] = await promptHidden(io, ["xoxc token (input hidden): ", 'xoxd "d" cookie (input hidden): ']);
    return { token: t, cookie: c };
  }
  const lines = (await readAll(io.stdin))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new SlackerError("Expected two lines on stdin: the xoxc token, then the xoxd cookie. Or set SLACK_TOKEN and SLACK_COOKIE.", "invalid_argument");
  }
  return { token: lines[0], cookie: lines[1] };
}

/** Strict whole-number option parser with an inclusive range. */
function intArg(min: number, max: number) {
  return (value: string): number => {
    const v = value.trim();
    const n = /^\d+$/.test(v) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) throw new InvalidArgumentError(`Expected a whole number from ${min} to ${max}.`);
    return n;
  };
}

const TIME_FORMATS = "30m, 2h, 7d, 1w, today, yesterday, 2026-09-01, 2026-09-01T09:30, or a Slack ts";
const tsOption = () => new Option("--ts <ts>", "message timestamp (not needed when target is a message link)");

/** Optimal-string-alignment distance (a transposition counts as one edit). */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function unknownCommand(program: Command, name: string): SlackerError {
  const names = program.commands.flatMap((c) => [c.name(), ...c.aliases()]);
  let best: string | undefined;
  let bestDistance = Math.max(1, Math.floor(name.length * 0.4));
  for (const candidate of names) {
    const distance = editDistance(name.toLowerCase(), candidate);
    if (distance <= bestDistance) [best, bestDistance] = [candidate, distance];
  }
  const suggestion = best ? ` (Did you mean ${best}?)` : "";
  return new SlackerError(`unknown command '${name}'${suggestion}. Run slacker --help for the list of commands.`, "unknown_command");
}

/** Alias / team mismatch / missing teamId for the selected workspace, given the live whoami. */
function identityOf(ctx: Context, me: LiveTeam & { aliases: string[] }): IdentityProblem[] {
  return identityProblems(ctx.session.workspace(), me.aliases, me);
}

/** The `warning` field whoami results carry (same text as the MCP whoami tool). */
function identityWarning(ctx: Context, me: LiveTeam & { aliases: string[] }): { warning?: string } {
  const problems = identityOf(ctx, me);
  return problems.length ? { warning: withRunNote(problems.map((p) => p.message).join(" ")) } : {};
}

const allowAliasOption = () =>
  new Option("--allow-alias", "write even though config.json can't vouch for this workspace's team (another name shares it, or no teamId)");

const CONVERSATION_TYPE: Record<string, string> = { channel: "channel", private_channel: "private", dm: "DM", group_dm: "group DM" };

// ── The CLI ──────────────────────────────────────────────

export function buildCli(ioOverrides: Partial<CliIO> = {}): Command {
  const io: CliIO = {
    stdin: process.stdin,
    cwd: process.cwd(),
    jsonErrors: false,
    execPath: process.execPath,
    nodeCandidates: STABLE_NODE_CANDIDATES,
    ...ioOverrides,
  };

  /** Run a command: print JSON with --json, otherwise hand the result to the human printer. */
  function run<A extends unknown[], T>(fn: (ctx: Context, ...args: A) => Promise<T> | T, human: (result: T, ctx: Context) => void) {
    return async (...args: unknown[]) => {
      const ctx = new Context(args[args.length - 1] as Command, io);
      const result = await fn(ctx, ...(args.slice(0, -1) as A));
      if (ctx.opts.json) printJson(result);
      else human(result, ctx);
    };
  }

  const program = new Command()
    .name("slacker")
    .description("Slack as you, from the terminal or as an MCP server — using slack-cli credentials.")
    .version(VERSION)
    .exitOverride()
    .configureOutput({
      writeErr: (s) => {
        if (!io.jsonErrors) process.stderr.write(s);
      },
    })
    .configureHelp({ showGlobalOptions: true })
    .showHelpAfterError("(add --help for usage)")
    // Every hint printed from here on names a non-default config file with -c.
    .hook("preAction", (_program, action) => setActiveConfig(configPath(action.optsWithGlobals<GlobalOpts>().config)))
    .option("-w, --workspace <name>", "workspace from config.json (default: SLACKER_WORKSPACE, .slacker.json, then defaultWorkspace)")
    .option("-c, --config <path>", "config file (default: SLACKER_CONFIG or ~/.config/slack-cli/config.json)")
    .option("--json", "print JSON (errors too: {\"error\": {\"message\", \"code\", \"hint\"}})")
    .addHelpText(
      "after",
      `
Targets:
  #channel or channel     a channel — bare names only ever match channels
  @handle, email, U…      a person (DM); people always need @handle, an email, or their user ID
  C…/D…/G… (or #C…)       a conversation ID
  a Slack link            a channel or message link (….slack.com/archives/… or app.slack.com/client/…);
                          send/thread/edit/delete/react use that message
Quote "#channel" in bash (an unquoted # starts a comment). Quote message text as ONE argument;
put -- before text that starts with "-". Use "-" as the text to read it from stdin.

Times (--since/--until): ${TIME_FORMATS}.

Examples:
  slacker send general "Deploy is done ✅"
  slacker send @alice "got a minute?"
  slacker send general --dry-run "where would this go?"
  slacker send https://acme.slack.com/archives/C0123ABCD/p1700000000123456 "replying in that thread"
  slacker send general -- "-1 from me"
  git log -1 --format=%B | slacker send '#releases' -
  slacker read general -n 10 --since 2h
  slacker thread https://acme.slack.com/archives/C0123ABCD/p1700000000123456
  slacker search "in:#eng from:@alice after:2026-09-01"
  slacker init my-workspace --mcp`
    );

  // ── MCP server ─────────────────────────────────────────
  program
    .command("serve", { isDefault: true })
    .description("start the MCP server on stdio (the default when stdin isn't a terminal)")
    .option("--read-only", "hide all write tools")
    .allowExcessArguments()
    .action(async (o: { readOnly?: boolean }, cmd: Command) => {
      // Unknown commands land here because serve is the default command.
      if (cmd.args.length) {
        if (program.args[0] === "serve") throw new SlackerError(`serve takes no arguments (got "${cmd.args.join(" ")}").`, "invalid_argument");
        throw unknownCommand(program, cmd.args[0]);
      }
      const g = cmd.optsWithGlobals<GlobalOpts>();
      // Bare `slacker` typed in a terminal wants help; MCP clients (stdin is a pipe) want the server.
      if (io.stdin.isTTY && program.args.length === 0 && !g.workspace && !g.config) {
        program.outputHelp();
        return;
      }
      const configFile = configPath(g.config);
      let opts: Parameters<typeof startServer>[0];
      try {
        const choice = chooseWorkspace(g.workspace, io.cwd);
        opts = { workspace: choice.name, configFile, readOnly: !!o.readOnly || choice.readOnly, choice };
      } catch (e) {
        // Corrupt .slacker.json: start degraded so the MCP client shows the reason (D10).
        opts = { configFile, readOnly: !!o.readOnly || parseBoolEnv(process.env.SLACKER_READ_ONLY), startupError: errorMessage(e) };
      }
      if (io.stdin.isTTY) {
        console.error(dim("slacker MCP server listening on stdio — Ctrl+C to quit. Run `slacker --help` for CLI commands."));
      }
      await startServer(opts);
    });

  // ── Identity ───────────────────────────────────────────
  program
    .command("whoami")
    .description("show the workspace and user slacker acts as")
    .action(
      run(
        async (ctx) => {
          const me = await ctx.session.whoami();
          const { source, projectFile, readOnly } = ctx.choice;
          return { ...me, source, projectFile: projectFile ?? null, readOnly, ...identityWarning(ctx, me) };
        },
        (me, ctx) => {
          console.log(`${bold(me.user)} in ${bold(me.team)} ${dim(`(${me.url}${me.enterpriseId ? ` · enterprise ${me.enterpriseId}` : ""})`)}`);
          const via =
            me.source === "project"
              ? `${PROJECT_FILE} at ${me.projectFile}`
              : me.source === "flag"
                ? "--workspace"
                : me.source === "env"
                  ? "SLACKER_WORKSPACE"
                  : "defaultWorkspace in config.json";
          console.log(dim(`Workspace "${me.workspace}" chosen via ${via}${me.readOnly ? " · read-only" : ""}`));
          printWarnings(identityOf(ctx, me).map((p) => p.message));
        }
      )
    );

  // ── Reading ────────────────────────────────────────────
  program
    .command("read")
    .description("read recent messages from a channel or DM")
    .argument("<target>", "#channel, @person, conversation ID, or link")
    .option("-n, --limit <n>", "number of messages (1-200)", intArg(1, 200), 20)
    .option("--since <time>", `only messages after this time (${TIME_FORMATS})`)
    .option("--until <time>", "only messages before this time (same formats)")
    .option("--cursor <cursor>", "page cursor from a previous result")
    .action(
      run(
        (ctx, target: string, o: { limit: number; since?: string; until?: string; cursor?: string }) =>
          ctx.session.readMessages({ target, limit: o.limit, oldest: o.since, latest: o.until, cursor: o.cursor }),
        (r) => {
          printMessages(r.messages);
          if (!r.count) console.log(dim("No messages."));
          printNote(r.note);
          if (r.nextCursor) console.log(dim(`Older messages: --cursor ${r.nextCursor}`));
        }
      )
    );

  program
    .command("thread")
    .description("read a message and its replies")
    .argument("<target>", "message link, or a channel together with ts")
    .argument("[ts]", "parent message timestamp")
    .option("-n, --limit <n>", "max messages (1-1000)", intArg(1, 1000), 100)
    .option("--cursor <cursor>", "page cursor from a previous result")
    .action(
      run(
        (ctx, target: string, ts: string | undefined, o: { limit: number; cursor?: string }) =>
          ctx.session.readThread({ target, ts, limit: o.limit, cursor: o.cursor }),
        (r) => {
          printMessages(r.messages);
          if (!r.count) console.log(dim("No messages."));
          printNote(r.note);
          if (r.nextCursor) console.log(dim(`More replies: --cursor ${r.nextCursor}`));
        }
      )
    );

  program
    .command("search")
    .description("search messages (Slack search syntax: in:#chan from:@user after:2026-09-01 has:link …)")
    .argument("<query...>")
    .option("-n, --limit <n>", "results per page (1-100)", intArg(1, 100), 20)
    .addOption(new Option("--sort <order>", "sort order").choices(["timestamp", "score"]).default("timestamp"))
    .option("--page <n>", "page number (1-100)", intArg(1, 100), 1)
    .action(
      run(
        (ctx, query: string[], o: { limit: number; sort: "timestamp" | "score"; page: number }) =>
          ctx.session.searchMessages({ query: query.join(" "), limit: o.limit, sort: o.sort, page: o.page }),
        (r) => {
          for (const m of r.matches) {
            const where = `${cyan(m.channel ?? "?")}${m.channelType === "private_channel" ? dim(" (private)") : ""}`;
            console.log(`${where}  ${bold(m.user ?? "?")}  ${dim(localTime(m.time))}`);
            if (m.text) console.log(`  ${m.text.split("\n").join("\n  ")}`);
            if (m.permalink) console.log(`  ${dim(m.permalink)}`);
            console.log();
          }
          const paging = r.pages > 0 ? ` · page ${r.page}/${r.pages}${r.page < r.pages ? ` · next: --page ${r.page + 1}` : ""}` : "";
          console.log(dim(`${plural(r.total, "match", "matches")}${paging}`));
        }
      )
    );

  program
    .command("channels")
    .description("list channels you're in (or --all public channels)")
    .option("-a, --all", "browse all public channels, not just joined ones")
    .option("-f, --filter <text>", "filter by name")
    .option("-n, --limit <n>", "max channels (1-1000)", intArg(1, 1000), 200)
    .option("--cursor <cursor>", "page cursor from a previous result")
    .action(
      run(
        (ctx, o: { all?: boolean; filter?: string; limit: number; cursor?: string }) =>
          ctx.session.listChannels({ joinedOnly: !o.all, query: o.filter, limit: o.limit, cursor: o.cursor }),
        (r) => {
          printTable(
            r.channels.map((c) => [
              `#${c.name}`,
              dim(c.id),
              c.private ? yellow("private") : "",
              c.members !== undefined ? dim(plural(c.members, "member")) : "",
              c.topic || c.purpose ? dim((c.topic || c.purpose || "").replace(/\s+/g, " ").slice(0, 60)) : "",
            ])
          );
          console.log(dim(plural(r.count, "channel")));
          if (r.truncated) console.log(yellow("More matches than fit — narrow --filter or raise -n."));
          if (r.nextCursor) console.log(dim(`More: --cursor ${r.nextCursor}`));
        }
      )
    );

  program
    .command("users")
    .alias("find")
    .description("find people by name, @handle or email (no query: list everyone)")
    .argument("[query...]")
    .option("-n, --limit <n>", "max results (1-50 with a query, 1-200 when listing; default 10 / 100)", intArg(1, 200))
    .option("--cursor <cursor>", "page cursor from a previous listing")
    .action(
      run(
        (ctx, words: string[], o: { limit?: number; cursor?: string }) => {
          const query = words.join(" ").trim();
          if (query && o.limit !== undefined && o.limit > 50) throw new SlackerError("With a query, -n can be at most 50.", "invalid_argument");
          if (query && o.cursor) throw new SlackerError("--cursor only applies when listing everyone (no query).", "invalid_argument");
          return ctx.session.findUsers(query ? { query, limit: o.limit ?? 10 } : { limit: o.limit ?? 100, cursor: o.cursor });
        },
        (r) => {
          if (!r.count) console.log(dim("No matches."));
          printTable(r.users.map((u) => [bold(`@${u.username ?? "?"}`), u.realName ?? "", dim(u.id), dim(u.title ?? ""), dim(u.email ?? "")]));
          if (r.nextCursor) console.log(dim(`More: --cursor ${r.nextCursor}`));
        }
      )
    );

  program
    .command("unread")
    .description("list conversations with unread messages or mentions")
    .option("-n, --limit <n>", "max conversations (1-100)", intArg(1, 100), 30)
    .action(
      run(
        (ctx, o: { limit: number }) => ctx.session.listUnread({ limit: o.limit }),
        (r) => {
          if (!r.total && !r.threadsHaveUnreads) return console.log(green("All caught up."));
          printTable(
            r.conversations.map((c) => [
              bold(c.name),
              dim(CONVERSATION_TYPE[c.type] ?? c.type),
              c.mentions ? yellow(`${c.mentions} @`) : "",
              dim(localTime(c.latest)),
              dim(c.id),
              c.archived ? yellow("archived") : "",
            ])
          );
          const more = r.total - r.conversations.length;
          if (more > 0) console.log(dim(`${plural(more, "more conversation", "more conversations")} — raise -n to see them.`));
          if (r.threadsHaveUnreads) console.log(cyan(`Threads have unreads${r.threadMentions ? ` (${plural(r.threadMentions, "mention")})` : ""}`));
        }
      )
    );

  program
    .command("status")
    .description("show your status (or someone else's); --set / --clear to change yours")
    .argument("[user]", "@handle, email or user ID (default: you)")
    .option("--set <text>", "set your status text")
    .option("--emoji <emoji>", "status emoji, e.g. :calendar: (with --set)")
    .option("--expires <minutes>", "clear the status after N minutes (with --set; 0-525600)", intArg(0, 525_600))
    .option("--clear", "clear your status")
    .addOption(allowAliasOption())
    .action(
      run(
        async (ctx, user: string | undefined, o: { set?: string; emoji?: string; expires?: number; clear?: boolean; allowAlias?: boolean }) => {
          const setting = o.set !== undefined;
          if (setting || o.clear) {
            if (user) throw new SlackerError(`--set/--clear change your own status; you can't change ${user}'s. Drop "${user}".`, "invalid_argument");
            if (setting && o.clear) throw new SlackerError("Use --set or --clear, not both.", "invalid_argument");
          }
          if (!setting && (o.emoji !== undefined || o.expires !== undefined)) {
            throw new SlackerError('--emoji and --expires go with --set, e.g. slacker status --set "In a meeting" --emoji :calendar: --expires 60', "invalid_argument");
          }
          if (setting || o.clear) {
            ctx.assertWritable();
            return ctx.session.setStatus({
              text: o.clear ? "" : (o.set ?? ""),
              emoji: o.clear ? "" : o.emoji,
              expiresInMinutes: o.expires,
              allowAlias: !!o.allowAlias,
            });
          }
          if (o.allowAlias) throw new SlackerError("--allow-alias goes with --set or --clear (reading a status needs no override).", "invalid_argument");
          return ctx.session.getStatus({ user });
        },
        (r) => {
          if ("status" in r) {
            console.log(green(r.status === "cleared" ? "✓ Status cleared" : `✓ Status set: ${r.emoji ? `${r.emoji} ` : ""}${r.text}`) + (r.expires ? dim(` until ${localTime(r.expires)}`) : ""));
            console.log(destinationLine("your status", r.team, r.workspace));
            return;
          }
          const status = r.statusText || r.statusEmoji ? `${r.statusEmoji ?? ""} ${r.statusText ?? ""}`.trim() : dim("no status");
          console.log(`${bold(r.name ?? r.userId)}  ${status}${r.statusExpires ? dim(` until ${localTime(r.statusExpires)}`) : ""}${r.presence ? dim(` · ${r.presence}`) : ""}`);
        }
      )
    );

  // ── Writing (as you) ───────────────────────────────────
  program
    .command("send")
    .description("send a message as you")
    .argument("<target>", "#channel, @person, conversation ID, or message link (replies in its thread)")
    .argument("<text>", 'the message, quoted as one argument; "-" reads it from stdin')
    .option("-t, --thread <ts>", "reply in this thread (inferred from a message link)")
    .option("--broadcast", "with a thread reply, also post it to the channel")
    .option("--dry-run", "show where the message would go without sending it")
    .addOption(allowAliasOption())
    .allowExcessArguments()
    .action(
      run(
        async (ctx, target: string, textArg: string, o: { thread?: string; broadcast?: boolean; dryRun?: boolean; allowAlias?: boolean }) => {
          const text = await messageText(ctx, textArg, "send");
          if (!o.dryRun) ctx.assertWritable();
          const r = await ctx.session.sendMessage({
            target,
            text,
            threadTs: o.thread,
            alsoSendToChannel: !!o.broadcast,
            dryRun: !!o.dryRun,
            allowAlias: !!o.allowAlias,
          });
          return r.dryRun ? { ...r, text } : r;
        },
        (r) => {
          const label = r.destination.name + (r.threadTs ? ` (thread ${r.threadTs})` : "");
          if (r.dryRun) {
            console.log(destinationLine(label, r.team, r.workspace, yellow("Would send to")));
            if ("text" in r) console.log(r.text.split("\n").map((l) => `  ${l}`).join("\n"));
            console.log(dim("Dry run — nothing was sent."));
            return;
          }
          console.log(green(`✓ Sent${r.threadTs ? " in thread" : ""}`) + dim(` · ${r.ts}`));
          console.log(destinationLine(label, r.team, r.workspace));
          if (r.permalink) console.log(dim(r.permalink));
        }
      )
    );

  program
    .command("edit")
    .description("edit one of your messages")
    .argument("<target>", "message link, or a channel together with --ts")
    .argument("<text>", 'the new text, quoted as one argument; "-" reads it from stdin')
    .addOption(tsOption())
    .addOption(allowAliasOption())
    .allowExcessArguments()
    .action(
      run(
        async (ctx, target: string, textArg: string, o: { ts?: string; allowAlias?: boolean }) => {
          const text = await messageText(ctx, textArg, "edit");
          ctx.assertWritable();
          return ctx.session.editMessage({ target, ts: o.ts, text, allowAlias: !!o.allowAlias });
        },
        (r) => {
          console.log(green("✓ Edited") + dim(` · ${r.ts}`));
          console.log(destinationLine(r.destination.name, r.team, r.workspace));
        }
      )
    );

  program
    .command("delete")
    .description("delete one of your messages")
    .argument("<target>", "message link, or a channel together with --ts")
    .addOption(tsOption())
    .option("-y, --yes", "don't ask for confirmation (the prompt shows the resolved destination; required without a TTY)")
    .addOption(allowAliasOption())
    .action(
      run(
        async (ctx, target: string, o: { ts?: string; yes?: boolean; allowAlias?: boolean }) => {
          ctx.assertWritable();
          // Asked only after the ts, the identity and the destination check out, so it can say where.
          const ask = async (w: { ts: string; team: string; workspace: string; destination: { name: string } }) => {
            if (!ctx.io.stdin.isTTY) throw new SlackerError("Refusing to delete without confirmation. Pass --yes.", "confirmation_required");
            return confirm(ctx.io, `Delete message ${w.ts} in ${w.destination.name} · team "${w.team}" (workspace "${w.workspace}")?`);
          };
          return ctx.session.deleteMessage({ target, ts: o.ts, allowAlias: !!o.allowAlias, confirm: o.yes ? undefined : ask });
        },
        (r) => {
          console.log(green("✓ Deleted") + dim(` · ${r.ts}`));
          console.log(destinationLine(r.destination.name, r.team, r.workspace));
        }
      )
    );

  program
    .command("react")
    .description("add an emoji reaction to a message")
    .argument("<target>", "message link, or a channel together with --ts")
    .argument("<emoji>", "e.g. thumbsup or :eyes:")
    .addOption(tsOption())
    .addOption(allowAliasOption())
    .action(
      run(
        async (ctx, target: string, emoji: string, o: { ts?: string; allowAlias?: boolean }) => {
          ctx.assertWritable();
          return ctx.session.addReaction({ target, ts: o.ts, emoji, allowAlias: !!o.allowAlias });
        },
        (r) => {
          console.log(green(`✓ Reacted :${r.emoji}:`) + dim(` · ${r.ts}`));
          console.log(destinationLine(r.destination.name, r.team, r.workspace));
        }
      )
    );

  // ── Project setup ──────────────────────────────────────
  program
    .command("init")
    .description(`pin this project to a workspace (writes ${PROJECT_FILE}; --mcp also registers the MCP server in .mcp.json)`)
    .argument("[workspaces...]", "workspace name(s) from config.json (default: --workspace, SLACKER_WORKSPACE, existing .slacker.json, defaultWorkspace)")
    .option("--mcp", "also register the slacker MCP server in ./.mcp.json")
    .option("--mcp-only", `only write .mcp.json (leave ${PROJECT_FILE} alone)`)
    .option("--name <server>", 'server name in .mcp.json (single workspace; default "slacker", or slacker-<workspace> for several)')
    .option("--read-only", "make this project read-only (CLI writes refused, MCP write tools hidden)")
    .option("--no-read-only", "make this project writable again")
    .option("--allow-alias", "pin a workspace config.json can't vouch for (shares its team with another name, has no teamId, or signs in to another team)")
    .option(
      "--replace",
      "overwrite a non-slacker .mcp.json entry or an invalid .slacker.json (--mcp-only leaves it alone); remove an older plain \"slacker\" entry when registering several workspaces"
    )
    .addOption(new Option("--force", "same as --allow-alias --replace").hideHelp())
    .option("--node <path>", "with --mcp: node executable .mcp.json runs this install's entry with (e.g. one outside nvm)")
    .option(
      "--command <cmd>",
      "with --mcp: command .mcp.json runs (default: the absolute path of slacker when it's on PATH, else node + this install's entry); entry path is kept unless <cmd> is slacker"
    )
    .action(
      run(
        (ctx, names: string[], o: InitOpts) =>
          initProject(names, o, {
            configFile: ctx.file,
            cwd: ctx.io.cwd,
            workspaceFlag: ctx.opts.workspace,
            execPath: ctx.io.execPath,
            nodeCandidates: ctx.io.nodeCandidates,
          }),
        (r, ctx) => printInit(r, ctx.cmd.opts<InitOpts>(), ctx.file)
      )
    );

  // ── Credentials ────────────────────────────────────────
  const auth = program.command("auth").description("manage workspace credentials in config.json");

  auth
    .command("setup")
    .description("import every signed-in workspace from the Slack desktop app")
    .action(
      run(
        (ctx) => authSetup(ctx.file),
        (r) => {
          for (const w of r.workspaces) console.log(green(`✓ ${w.updated ? "Updated" : "Added"} "${w.name}"`) + dim(` · ${w.team} as ${w.user}`));
          for (const f of r.failures) console.log(yellow(`✗ ${f.token}: ${f.error}`));
          printWarnings(r.warnings);
          printNotes(r.notes);
          console.log(dim(`Saved to ${r.config} (${plural(r.tokensFound, "token")} found)`));
        }
      )
    );

  auth
    .command("refresh")
    .description("re-read tokens and the session cookie from Slack desktop (fixes invalid_auth)")
    .action(
      run(
        (ctx) => authRefresh(ctx.file),
        (r) => {
          if (r.refreshed.length) console.log(green(`✓ Refreshed ${r.refreshed.join(", ")}`));
          else console.log(yellow("Nothing refreshed."));
          for (const u of r.untouched) console.log(yellow(`- ${u.name}: ${u.reason}`));
          for (const f of r.failures) console.log(yellow(`✗ ${f.token}: ${f.error}`));
        }
      )
    );

  auth
    .command("list")
    .description("list workspaces and verify each one live")
    .action(
      run(
        (ctx) => authList(ctx.file),
        (r) => {
          if (!r.workspaces.length) printNotes([withRunNote(`No workspaces in ${r.config}. Run: slacker auth setup`)]);
          printTable(
            r.workspaces.map((w) => [
              (w.default ? "* " : "  ") + bold(w.name),
              w.ok ? green("ok") : yellow("error"),
              w.ok ? `${w.team} as ${w.user}` : (w.error ?? ""),
              dim(w.teamId ?? ""),
              dim(w.url),
            ])
          );
          printWarnings(r.warnings);
        }
      )
    );

  auth
    .command("test")
    .description("check the selected workspace's credentials")
    .action(
      run(
        async (ctx) => {
          const me = await ctx.session.whoami();
          return { ...me, ...identityWarning(ctx, me) };
        },
        (me, ctx) => {
          console.log(green(`✓ ${me.workspace}`) + ` → ${me.user} in ${me.team} ${dim(me.url)}`);
          printWarnings(identityOf(ctx, me).map((p) => p.message));
        }
      )
    );

  auth
    .command("default")
    .description("set the fallback workspace")
    .argument("<name>")
    .action(
      run(
        (ctx, name: string) => authDefault(ctx.file, name),
        (r) => console.log(green(`✓ Default workspace: ${r.defaultWorkspace}`))
      )
    );

  auth
    .command("add")
    .description("add credentials by hand: reads SLACK_TOKEN/SLACK_COOKIE, else prompts (hidden), else two lines of stdin")
    .argument("<name>", "workspace name to save them under")
    .option("--force", "replace an existing entry that belongs to a different team")
    .addOption(new Option("--token <xoxc>").hideHelp())
    .addOption(new Option("--cookie <xoxd>").hideHelp())
    .action(
      run(
        async (ctx, name: string, o: { force?: boolean; token?: string; cookie?: string }) => {
          if (o.token !== undefined || o.cookie !== undefined) {
            throw new SlackerError(
              withRunNote(
                "--token/--cookie were removed: secrets in arguments end up in shell history. " +
                  `Run \`slacker auth add ${name}\` and paste them when asked, or set SLACK_TOKEN and SLACK_COOKIE.`
              ),
              "secret_in_argv"
            );
          }
          const { token, cookie } = await readSecrets(ctx.io);
          return authAdd(ctx.file, name, token, cookie, { force: o.force });
        },
        (r) => {
          const verb = r.replaced ? "Replaced" : r.updated ? "Updated" : "Added";
          console.log(green(`✓ ${verb} "${r.workspace}"`) + dim(` · ${r.team} (${r.teamId}) as ${r.user}`));
          printWarnings(r.warnings);
          printNotes(r.notes);
        }
      )
    );

  auth
    .command("remove")
    .description("remove a workspace from config.json")
    .argument("<name>")
    .action(
      run(
        (ctx, name: string) => authRemove(ctx.file, name),
        (r) => {
          console.log(green(`✓ Removed "${r.removed}"`) + dim(` · default workspace: ${r.defaultWorkspace ?? "(none)"}`));
          printNotes(r.notes);
        }
      )
    );

  auth
    .command("rename")
    .description("rename a workspace in config.json")
    .argument("<old>")
    .argument("<new>")
    .action(
      run(
        (ctx, oldName: string, newName: string) => authRename(ctx.file, oldName, newName),
        (r) => {
          console.log(green(`✓ Renamed "${r.renamed.from}" → "${r.renamed.to}"`) + dim(` · default workspace: ${r.defaultWorkspace ?? "(none)"}`));
          printNotes(r.notes);
        }
      )
    );

  return program;
}

// ── Entry point ──────────────────────────────────────────

/** --json anywhere before a `--` terminator. */
function wantsJson(args: string[]): boolean {
  const end = args.indexOf("--");
  return (end < 0 ? args : args.slice(0, end)).includes("--json");
}

interface ErrorReport {
  message: string;
  code?: string;
  hint?: string;
}

const DASH_HINT = 'Put -- before message text that starts with "-": slacker send general -- "-1 from me"';

/** Message text starting with "-" that commander took for an option (e.g. `send general "-w side"`). */
const looksLikeDashText = (args: string[]) => args.some((a) => /^-[^-]/.test(a) && /\s/.test(a));

function describeError(e: unknown, args: string[] = []): ErrorReport {
  if (e instanceof SlackApiError) {
    // The message is "Slack API error (method): code — hint".
    const message = e.hint ? e.message.slice(0, -(e.hint.length + 3)) : e.message;
    return { message, code: e.code, ...(e.hint && { hint: e.hint }) };
  }
  if (e instanceof SlackerError) return { message: e.message, code: e.code, ...(e.hint && { hint: e.hint }) };
  if (e instanceof CommanderError) {
    // "commander.help": a command group (e.g. `auth`) was run without a subcommand.
    const message = e.code === "commander.help" ? "Missing a subcommand. Add --help to list them." : e.message.replace(/^error: /, "");
    // An "unknown option" with spaces in it is message text that starts with "-"; so is an option
    // that swallowed such text and left the command short of an argument.
    const textLike =
      (e.code === "commander.unknownOption" && /'[^']*\s[^']*'/.test(message)) ||
      (e.code === "commander.missingArgument" && looksLikeDashText(args));
    return { message, code: e.code, ...(textLike && { hint: DASH_HINT }) };
  }
  if (e instanceof SlackNetworkError) return { message: e.message, code: "network_error" };
  return { message: errorMessage(e) };
}

export async function main(argv: string[] = process.argv, io: Partial<CliIO> = {}): Promise<void> {
  const args = argv.slice(2);
  const json = wantsJson(args);
  setActiveConfig(undefined); // the preAction hook sets the real one (-c / SLACKER_CONFIG) before any command runs
  try {
    await buildCli({ ...io, jsonErrors: json }).parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError && e.exitCode === 0) return; // --help / --version
    const report = describeError(e, args);
    if (json) {
      console.log(JSON.stringify({ error: report }, null, 2));
    } else if (e instanceof CommanderError) {
      // commander already printed its message.
      if (report.hint) console.error(report.hint);
    } else {
      // The message is self-contained (it already includes any hint).
      console.error(`slacker: ${e instanceof Error ? e.message : report.message}`);
    }
    process.exit(e instanceof CommanderError && e.exitCode ? e.exitCode : 1);
  }
}
