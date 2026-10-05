# slacker setup guide

A step-by-step walkthrough, from a fresh machine to Claude Code posting Slack messages as you, with one Slack
workspace per project. Each step ends with a check so you know it worked.

It takes about 10 minutes. For every option and edge case, see the [reference](reference.md).

1. [Install](#1-install)
2. [Import your Slack credentials](#2-import-your-slack-credentials)
3. [Try it from the terminal](#3-try-it-from-the-terminal)
4. [Pin a project to a workspace](#4-pin-a-project-to-a-workspace)
5. [Connect Claude Code](#5-connect-claude-code)
6. [Use different workspaces in different projects](#6-use-different-workspaces-in-different-projects)
7. [Keeping it working](#7-keeping-it-working)
8. [Uninstall](#8-uninstall)

## Before you start

You need:

- **macOS or Linux.** On Windows, credential import isn't supported; you can still add credentials by hand
  (see [step 2](#no-desktop-app-or-on-windows)).
- **Node.js 22.12 or newer.** Check with `node -v`.
- **The Slack desktop app**, signed in to every workspace you want to use.
- **`sqlite3`** on your PATH. It's preinstalled on macOS; on Linux install it with your package manager.

You do **not** need slack-cli installed. slacker uses the same credentials file
(`~/.config/slack-cli/config.json`), so if you already have it, slacker picks up your workspaces, and if not,
step 2 creates the file.

## 1. Install

```bash
git clone https://github.com/manasnilorout/slacker.git
cd slacker
npm install      # installs dependencies and builds dist/
npm link         # puts the `slacker` command on your PATH
```

**Check:**

```console
$ slacker --version
0.1.0
```

> **Using nvm?** `npm link` installs `slacker` into the current Node version's directory, so it disappears
> when you switch Node versions. That's fine for the terminal. For Claude Code, step 4 shows how to point the
> server at a Node install outside nvm.

## 2. Import your Slack credentials

```bash
slacker auth setup
```

slacker reads the session of every workspace the Slack desktop app is signed in to and saves them.

- **macOS shows a Keychain prompt** for "Slack Safe Storage". Click **Allow**. ("Always Allow" also works, but
  lets any program running as you read that item later without asking.) The prompt can hide behind other
  windows.
- Each workspace is saved under a short name based on its team name, for example "Acme Corp" → `acme-corp`.

```console
$ slacker auth setup
✓ Added "acme-corp" · Acme Corp as alice
✓ Added "side-project" · Side Project as alice
"acme-corp" is now the default workspace. Change it with: slacker auth default <name>
Saved to ~/.config/slack-cli/config.json (2 tokens found)
```

**Check** that every name signs in to the team you expect:

```console
$ slacker auth list
* acme-corp     ok  Acme Corp as alice      T0ACME0001  https://acme-corp.slack.com/
  side-project  ok  Side Project as alice   T0SIDE0001  https://side-project.slack.com/
```

`*` marks the default workspace, the one used when nothing else picks one. Change it with
`slacker auth default <name>`, or rename an entry with `slacker auth rename <old> <new>`.

**If `auth list` prints a warning that two names share a team**, one entry is a copy of another. slacker
refuses to write from either name until that's fixed. The fix takes four commands; see
[Fixing duplicated workspace entries](reference.md#fixing-duplicated-workspace-entries).

### No desktop app, or on Windows

Copy the `xoxc-…` token and the `d` cookie (`xoxd-…`) from Slack open in a browser, then:

```bash
slacker auth add acme-corp     # prompts for both, without echoing them
```

Secrets are never passed as command-line flags. See [`auth add`](reference.md#adding-credentials-by-hand-auth-add)
for the environment-variable and stdin options.

## 3. Try it from the terminal

Everything below is read-only or a dry run, so nothing is posted.

```console
$ slacker whoami
alice in Acme Corp (https://acme-corp.slack.com/)
Workspace "acme-corp" chosen via defaultWorkspace in config.json

$ slacker channels
#general  C0GENERAL1    42 members  Company-wide announcements
#eng      C0ENGTEAM1    12 members
2 channels

$ slacker read general -n 1
2026-10-05 14:16  bob  1791190000.000100
  Deploy finished 🎉

$ slacker send general --dry-run "hello"
Would send to #general · team "Acme Corp" (workspace "acme-corp")
  hello
Dry run — nothing was sent.
```

When the dry run shows the right place, drop `--dry-run` to send for real. Every real write prints where it
landed the same way.

A few rules that prevent sending to the wrong place:

- A bare name like `general` only ever means a **channel**. People need `@handle`, an email, or a user ID.
- A Slack message link as the target **replies in that message's thread**.
- Quote the message as one argument: `slacker send general "Ship it"`.

To use a workspace other than the default for a single command, add `-w <name>`.

## 4. Pin a project to a workspace

In each project, tell slacker which workspace it belongs to, and register the MCP server for Claude Code:

```console
$ cd ~/work/acme-app
$ slacker init acme-corp --mcp
✓ Wrote .slacker.json → workspace "acme-corp" (https://acme-corp.slack.com/)
✓ Registered "slacker" in .mcp.json → workspace "acme-corp"
```

This writes two files in the project:

| File | Contents | Commit it? |
| --- | --- | --- |
| `.slacker.json` | `{ "workspace": "acme-corp" }`, which makes every `slacker` command in this directory (and below) use that workspace | Yes, if your team uses the same workspace names |
| `.mcp.json` | The MCP server entry Claude Code starts, with `--workspace acme-corp` | **No**, it holds paths from your machine. Add it to `.gitignore` |

The `.mcp.json` entry looks like this:

```json
{
  "mcpServers": {
    "slacker": {
      "command": "/opt/homebrew/bin/slacker",
      "args": ["serve", "--workspace", "acme-corp"]
    }
  }
}
```

**Options you may want:**

- **nvm users:** `init` warns that the Node path in the entry breaks when you switch Node versions, and
  suggests a Node install outside nvm if it finds one. Use it:

  ```bash
  slacker init acme-corp --mcp --node /opt/homebrew/bin/node
  ```

- **Read-only project:** `slacker init acme-corp --mcp --read-only`. The MCP server then exposes only read tools,
  and CLI writes from this directory are refused.
- **Don't want a project file at all?** Skip `--mcp` and register the server just for yourself, using the
  `claude mcp add --scope local …` command that `init` prints.

**Check:**

```console
$ slacker whoami
alice in Acme Corp (https://acme-corp.slack.com/)
Workspace "acme-corp" chosen via .slacker.json at /Users/alice/work/acme-app/.slacker.json
```

## 5. Connect Claude Code

1. Start (or restart) Claude Code in the project directory.
2. Claude Code asks whether to approve the `slacker` server from `.mcp.json`. Approve it.
3. Run `/mcp`. `slacker` should be listed as connected.
4. Ask Claude something like *"Use slacker's whoami tool: which Slack workspace are you connected to?"* It should
   answer with your team and workspace name.
5. Try a dry run: *"Draft a message to #general saying the build is green, and dry-run it with slacker. Don't
   send it."*

What Claude gets:

- **Read tools:** `read_messages`, `read_thread`, `search_messages`, `list_channels`, `find_user`,
  `list_unread`, `get_status`, `whoami`.
- **Write tools:** `send_message` (with `dry_run`), `edit_message`, `delete_message`, `add_reaction`,
  `set_status`. They're hidden in read-only mode.
- **Prompts:** `triage_unread`, `reply_to_thread`, `summarize_channel`.

The server tells Claude that Slack message content is untrusted data, and to write only when you explicitly ask.
Claude Code also asks your permission before each tool call unless you've allowed it, which is the main safety
check. See the [safety model](reference.md#safety-model).

**If `/mcp` shows slacker as failed**, or every tool returns `slacker is not configured: …`, the error message
names the problem and the fix. Common causes are a workspace name that doesn't exist (`slacker auth list`) or a
Node path that moved (re-run `init` with `--node`). After fixing config.json, reconnect the server from `/mcp`.

## 6. Use different workspaces in different projects

Run `init` in each project with that project's workspace:

```bash
cd ~/work/acme-app      && slacker init acme-corp --mcp
cd ~/code/side-project  && slacker init side-project --mcp
```

Each project's Claude Code session then talks to its own workspace, and `slacker` commands in each directory
use it too.

**Need two workspaces in one project?** List both. You get one MCP server per workspace (`slacker-acme-corp`,
`slacker-side-project`); the first is also pinned in `.slacker.json` for the CLI:

```bash
slacker init acme-corp side-project --mcp
```

**How slacker picks the workspace**, first match wins: the `-w` flag, then the `SLACKER_WORKSPACE` environment
variable, then the nearest `.slacker.json`, then the default in config.json. `slacker whoami` always says which
one it used.

To move a project to another workspace, run `slacker init <other-workspace> --mcp` there again, then reconnect
the server in `/mcp`.

## 7. Keeping it working

| Symptom | Fix |
| --- | --- |
| `invalid_auth` (credentials stale, usually a rotated cookie) | `slacker auth refresh`. If nothing is refreshed, `slacker auth setup`. |
| `token_revoked` / `token_expired` (you were signed out) | Sign the desktop app back in, then `slacker auth setup`. |
| You signed the desktop app in to a new workspace | `slacker auth setup` adds it, then `slacker init <name> --mcp` in its projects. |
| You switched Node versions and Claude Code can't start slacker | `slacker init <workspace> --mcp --node <stable node path>`, then reconnect in `/mcp`. |
| `Refusing to write until config.json is fixed` | Two names share a team. See [duplicates](reference.md#fixing-duplicated-workspace-entries). |

The MCP server re-reads config.json on every call, so `auth refresh` and `auth setup` take effect without
restarting it. More in [troubleshooting](reference.md#troubleshooting).

## 8. Uninstall

```bash
# 1. In each project: remove the pin and the MCP entry
rm .slacker.json            # and delete the "slacker" entry from .mcp.json
claude mcp remove slacker   # if you registered it with `claude mcp add` instead

# 2. Remove stored credentials you no longer want, while the command still exists
slacker auth remove <name>

# 3. Remove the command
npm rm -g @manasnilorout/slacker
```

The credentials file `~/.config/slack-cli/config.json` is shared with slack-cli, so only delete it if neither
tool needs it.
