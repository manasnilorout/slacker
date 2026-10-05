# Setting up slacker

The user runs these steps; you can run the read-only checks. **Never** print, copy or ask for Slack
tokens (`xoxc-…`) or cookies (`xoxd-…`), and never read `~/.config/slack-cli/config.json` yourself.
`slacker auth add` prompts for secrets without echoing them, so the user should type them there.

Full walkthrough: [setup guide](https://github.com/manasnilorout/slacker/blob/main/docs/setup-guide.md).

## Install

Needs macOS or Linux, Node.js 22.12+, `sqlite3`, and the Slack desktop app signed in to each workspace.

```bash
git clone https://github.com/manasnilorout/slacker.git
cd slacker
npm install && npm link
slacker --version
```

## Import credentials

```bash
slacker auth setup     # reads every workspace the Slack desktop app is signed in to
slacker auth list      # each name should show "ok" and a different team
```

On macOS, a Keychain prompt for "Slack Safe Storage" appears (it can hide behind other windows). The
user clicks Allow. `*` in `auth list` marks the default workspace; change it with
`slacker auth default <name>`.

## One workspace per project

In the project directory:

```bash
slacker init <workspace> --mcp                  # writes .slacker.json and .mcp.json
slacker init <workspace> --mcp --read-only      # read tools only
slacker init <workspace> --mcp --node /opt/homebrew/bin/node   # nvm users: a Node outside nvm
```

Then restart Claude Code in that directory, approve the `slacker` server, and check `/mcp`. Calling
`whoami` should name the expected workspace.

slacker picks the workspace in this order: `-w <name>`, then `SLACKER_WORKSPACE`, then the nearest
`.slacker.json`, then `defaultWorkspace` in config.json.

### Trusting a project's `.slacker.json`

- `slacker init <workspace>` trusts the `.slacker.json` it writes, on this machine.
- A `.slacker.json` the user didn't write (in a repo they cloned, say) is used for reads with a warning,
  but writes refuse with `untrusted_project` until the **user** checks the workspace it names
  (`slacker auth list`) and runs `slacker trust` in that project. A bare `slacker init` (no workspace
  name) refuses such a file too: the user names the workspace explicitly. Trust takes effect on the next
  write, in the CLI and in a running MCP server, with no reconnect. (If the file later names a different
  workspace, writes refuse with `project_changed` until the server is restarted.)
- Never run `slacker trust` or `slacker init`, and never add `-w`, to get past this yourself. Show the user
  the error and the workspace it names.
- **Trust doesn't cover `.mcp.json`.** An MCP entry passes `--workspace` itself, so a repo that ships its
  own `.mcp.json` decides the workspace its `slacker` server uses. Before the user approves the server in
  Claude Code, tell them to read the `slacker` entry's `--workspace` (and its `command`).

## Fixing problems

| Symptom | Fix (the user runs it) |
| --- | --- |
| `invalid_auth` | `slacker auth refresh`, or `slacker auth setup` if nothing was refreshed |
| `token_revoked` / `token_expired` | Sign the Slack desktop app back in, then `slacker auth setup` |
| Workspace not found | `slacker auth list` for the names, then `slacker init <name> --mcp` again |
| MCP server failed in `/mcp`, or every tool says "slacker is not configured" | Read the error: it names the fix. Usually a wrong workspace name or a Node path that moved (`init … --node`). Reconnect in `/mcp` afterwards |
| Two names share a team ("Refusing to write until config.json is fixed") | [Fixing duplicated workspace entries](https://github.com/manasnilorout/slacker/blob/main/docs/reference.md#fixing-duplicated-workspace-entries) |
| `untrusted_project` ("Refusing to write: … .slacker.json …") | The user checks the workspace it names, then runs `slacker trust` in that project. No reconnect needed. See [trusting a project's .slacker.json](https://github.com/manasnilorout/slacker/blob/main/docs/reference.md#trusting-a-projects-slackerjson) |
| `unsafe_symlink` from `init` | The user replaces the symlinked `.slacker.json`/`.mcp.json` with a regular file (or removes it), then reruns `init` |

The MCP server re-reads config.json on every call, so `auth refresh` and `auth setup` work without a
restart.
