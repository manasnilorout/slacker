# slacker

Use Slack **as yourself** from the terminal, and give AI agents like Claude Code the same access through a local
MCP server, with a different Slack workspace for each project.

```console
$ slacker send general --dry-run "Deploy is done ✅"
Would send to #general · team "Acme Corp" (workspace "acme-corp")
  Deploy is done ✅
Dry run — nothing was sent.
```

slacker signs in with your own Slack session (the `xoxc` token and `d` cookie the Slack desktop app uses), stored
in `~/.config/slack-cli/config.json`. It isn't a bot and needs no Slack app install or admin approval: it reads
what you can see, and what it sends shows up as you.

- **One binary, two modes.** `slacker <command>` is the CLI. `slacker serve` is the MCP server, and the
  same code backs both.
- **A workspace per project.** `slacker init <workspace> --mcp` pins a project to a workspace for both the CLI and
  Claude Code.
- **Built not to post in the wrong place.**
  - Bare names only ever match channels, never people.
  - Message links reply in their thread.
  - Every write checks the workspace's live team first.
  - `--dry-run` shows exactly where a message would go.
  - Retries never double-post, and when a post's outcome is unknown the error says so.
  - A `.slacker.json` from a cloned repo can't pick the workspace you write to until you `slacker trust` it.
    (A repo's own `.mcp.json` isn't covered: [check it before approving it](#how-the-workspace-is-chosen).)

**Docs:** [Setup guide](docs/setup-guide.md) (step by step, including Claude Code) ·
[Reference](docs/reference.md) (every command, option, tool and error)

## Quick start

You need macOS or Linux, Node.js 22.12+, `sqlite3` (preinstalled on macOS), and the Slack desktop app signed in
to your workspaces.

```bash
# 1. Install
git clone https://github.com/manasnilorout/slacker.git && cd slacker
npm install && npm link

# 2. Import your Slack sessions from the desktop app (macOS asks for Keychain access: click Allow)
slacker auth setup
slacker auth list                      # each name should show the team you expect

# 3. Try it (read-only, then a dry run)
slacker whoami
slacker read general -n 5
slacker send general --dry-run "hello"

# 4. Pin a project and register the MCP server for Claude Code
cd ~/work/my-project
slacker init acme-corp --mcp           # then approve the "slacker" server in Claude Code (/mcp)
```

Using nvm, on Windows, or without the desktop app? The [setup guide](docs/setup-guide.md) covers each case.

## Everyday CLI

```bash
slacker read general --since 2h                 # recent messages, oldest first
slacker thread <message-link>                   # a message and its replies
slacker search "in:#eng from:@alice after:2026-09-01"
slacker unread                                  # conversations with unreads / mentions
slacker channels --all --filter eng             # find channels
slacker users alice                             # find people (gives the @handle / ID)

slacker send general "Ship it 🚀"               # quote the message as one argument
slacker send @alice "got a minute?"             # people need @handle, email or user ID
slacker send <message-link> "on it"             # replies in that message's thread
git log -1 --format=%B | slacker send '#releases' -
slacker react <message-link> eyes
slacker status --set "Focusing" --emoji :headphones: --expires 60
```

Add `-w <workspace>` to any command to use another workspace, and `--json` for machine-readable output. Run
`slacker <command> --help` for options, or see the [CLI reference](docs/reference.md#cli-reference).

## With Claude Code (MCP)

After `slacker init <workspace> --mcp`, Claude Code starts slacker as an MCP server for that project. It gets:

| Kind | Names |
| --- | --- |
| Read tools | `whoami`, `read_messages`, `read_thread`, `search_messages`, `list_channels`, `find_user`, `list_unread`, `get_status` |
| Write tools | `send_message` (with `dry_run`), `edit_message`, `delete_message`, `add_reaction`, `set_status` |
| Prompts | `triage_unread`, `reply_to_thread`, `summarize_channel` |

- **Read-only projects:** `slacker init <workspace> --mcp --read-only` hides the write tools.
- **Several workspaces in one project:** `slacker init <ws-a> <ws-b> --mcp` registers one server per workspace.
- **Keep `.mcp.json` out of git.** It contains paths from your machine. `.slacker.json` can be committed, but
  it only chooses the workspace for writes on machines where it's trusted: teammates who clone the repo check the
  workspace it names and run `slacker trust` once (see [below](#how-the-workspace-is-chosen)). Trust is checked on
  every write, so `slacker trust` takes effect in a running server without reconnecting it.

Details: [connecting Claude Code](docs/setup-guide.md#5-connect-claude-code) ·
[tools and parameters](docs/reference.md#tools) · [safety model](docs/reference.md#safety-model).

## Claude Code plugin (skill + agent)

This repo is also a Claude Code plugin marketplace. The plugin teaches Claude how to use slacker well:

- **Skill `slacker:slacker`.** When you ask about Slack, Claude picks the MCP tools or the CLI, dry-runs
  before it writes, waits for your yes, and treats message content as data. It also explains slacker's errors.
- **Agent `slack-assistant`.** A subagent for triage, summaries, search and drafting replies. It only reads
  and drafts: it returns each draft with its dry-run destination, and the main conversation sends it after you
  approve.

Install it from inside Claude Code:

```text
/plugin marketplace add manasnilorout/slacker
/plugin install slacker@slacker
```

Or from a local clone: `/plugin marketplace add ~/path/to/slacker`, then the same install command.

The plugin ships no MCP server and no CLI. You still install slacker (clone, `npm install && npm link`), import
credentials, and run `slacker init <workspace> --mcp` in each project, as in the [quick start](#quick-start).

## How the workspace is chosen

The first match wins:

1. `-w/--workspace <name>`
2. `SLACKER_WORKSPACE`
3. The nearest `.slacker.json` (written by `slacker init`)
4. `defaultWorkspace` in config.json (`slacker auth default <name>`)

`slacker whoami` shows which one was used. An unknown name is an error. slacker never silently uses a different
workspace.

**A `.slacker.json` has to be trusted before it can choose the workspace for writes.** `slacker init <workspace>`
trusts the file it writes. A `.slacker.json` you didn't write (one in a repo you cloned, say) is used for reads
with a warning, but `send`, `edit`, `delete`, `react` and `status --set/--clear` refuse (`untrusted_project`)
until you check the workspace it names and run `slacker trust` there, or pass `-w` for one command. A bare
`slacker init` (no workspace name) refuses such a file too, so name the workspace explicitly. Changing the
workspace in the file needs trusting again. Its `"readOnly": true` always applies. A `.slacker.json` owned by
another user, or writable by others (e.g. one planted in `/tmp`), is ignored, and writes are refused while it's
there (so is one in a directory others can write to). If it's yours and only group-writable, `-w` or
`SLACKER_WORKSPACE` still lets you write, with a warning.
Details: [project trust](docs/reference.md#trusting-a-projects-slackerjson).

**Trust doesn't cover `.mcp.json`.** The entry `init` writes passes `--workspace` itself, so a repo that commits
its own `.mcp.json` chooses the workspace its `slacker` server writes to. Before you approve a project's
`slacker` server in Claude Code, read that entry's `--workspace` (and its `command`).

## When something goes wrong

| You see | Do this |
| --- | --- |
| `invalid_auth` | `slacker auth refresh`, then `slacker auth setup` if that doesn't fix it |
| `token_revoked` / `token_expired` | Sign the desktop app back in, then `slacker auth setup` |
| `No channel named "#x"` | Check with `slacker channels --all --filter x`; for a person use `@handle` |
| `Refusing to write until config.json is fixed` | Two names share one team: [fix duplicated entries](docs/reference.md#fixing-duplicated-workspace-entries) |
| `Refusing to write: …/.slacker.json picks workspace "x", but it isn't trusted on this machine` | Check that `x` is right for this project, then `slacker trust` there (or pass `-w <name>` for one command) |
| Claude Code can't start slacker / tools say `not configured` | Follow the fix in the message; [more](docs/setup-guide.md#5-connect-claude-code) |

Every error message names its fix. The full table is in [troubleshooting](docs/reference.md#troubleshooting).

## Security

These are full user-session credentials. Anyone who can read `config.json` can act as you, so slacker keeps it at
mode `0600`. Read-only mode is a guardrail, not a security boundary: an agent with shell access could still
run slacker or read the file.

slacker also treats project files and Slack content as untrusted: an untrusted `.slacker.json` can't choose the
workspace for writes (above; a repo's own `.mcp.json` is up to you to check), `slacker init` refuses a
`.slacker.json` or `.mcp.json` that is a symlink leading outside the project (`unsafe_symlink`), and terminal
escape sequences in Slack text (message text, names, topics, file names …) are stripped from human-readable CLI
output. See the [safety model](docs/reference.md#safety-model).

## Development

```bash
npm install          # installs and builds dist/
npm test             # vitest; all Slack calls are stubbed, no network
npm run typecheck    # src/ and tests/
npm run dev          # tsc --watch
```

Releasing: the version lives in both `package.json` and `plugin/.claude-plugin/plugin.json`. Bump both (a test
checks that they match).

Source layout and test helpers: [reference → Development](docs/reference.md#development).

## License

MIT. See [LICENSE](LICENSE).
