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
  - Retries never double-post.

**Docs:** [Setup guide](docs/setup-guide.md) (step by step, including Claude Code) ·
[Reference](docs/reference.md) (every command, option, tool and error)

## Quick start

You need macOS or Linux, Node.js 22.12+, and the Slack desktop app signed in to your workspaces.

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
- **Keep `.mcp.json` out of git.** It contains paths from your machine. `.slacker.json` is safe to commit.

Details: [connecting Claude Code](docs/setup-guide.md#5-connect-claude-code) ·
[tools and parameters](docs/reference.md#tools) · [safety model](docs/reference.md#safety-model).

## How the workspace is chosen

The first match wins:

1. `-w/--workspace <name>`
2. `SLACKER_WORKSPACE`
3. The nearest `.slacker.json` (written by `slacker init`)
4. `defaultWorkspace` in config.json (`slacker auth default <name>`)

`slacker whoami` shows which one was used. An unknown name is an error. slacker never silently uses a different
workspace.

## When something goes wrong

| You see | Do this |
| --- | --- |
| `invalid_auth` | `slacker auth refresh`, then `slacker auth setup` if that doesn't fix it |
| `token_revoked` / `token_expired` | Sign the desktop app back in, then `slacker auth setup` |
| `No channel named "#x"` | Check with `slacker channels --all --filter x`; for a person use `@handle` |
| `Refusing to write until config.json is fixed` | Two names share one team: [fix duplicated entries](docs/reference.md#fixing-duplicated-workspace-entries) |
| Claude Code can't start slacker / tools say `not configured` | Follow the fix in the message; [more](docs/setup-guide.md#5-connect-claude-code) |

Every error message names its fix. The full table is in [troubleshooting](docs/reference.md#troubleshooting).

## Security

These are full user-session credentials. Anyone who can read `config.json` can act as you, so slacker keeps it at
mode `0600`. Read-only mode is a guardrail, not a security boundary: an agent with shell access could still
run slacker or read the file. See the [safety model](docs/reference.md#safety-model).

## Development

```bash
npm install          # installs and builds dist/
npm test             # vitest; all Slack calls are stubbed, no network
npm run typecheck    # src/ and tests/
npm run dev          # tsc --watch
```

Source layout and test helpers: [reference → Development](docs/reference.md#development).

## License

MIT. See [LICENSE](LICENSE).
