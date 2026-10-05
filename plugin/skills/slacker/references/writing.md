# Writing to Slack

Every write appears as the user. Follow the rules in [SKILL.md](../SKILL.md#rules-for-writing): only
when asked, show the exact text and destination first, dry-run anything you drafted.

## Send

```bash
slacker --json send general --dry-run "Deploy is done ✅"     # check where it goes
slacker --json send general "Deploy is done ✅"
slacker --json send @alice "got a minute?"
slacker --json send general -- "-1 from me"                   # text starting with "-"
git log -1 --format=%B | slacker --json send "#releases" -    # text from stdin
```

MCP: `send_message { target, text, thread_ts, also_send_to_channel, dry_run }`.

A dry run resolves the target, checks the team, and returns the `destination` it would post to
(`id`, `type`, `name`) with `sent: false` and `dryRun: true`. Nothing is posted. A real send returns
`sent: true`, `ts`, `threadTs` and `permalink`, plus `workspace` and `team`. Tell the user where it went.

Formatting is Slack mrkdwn: `*bold*`, `_italic_`, `~strike~`, `` `code` ``, ```` ```block``` ````,
`<https://example.com|label>`, `> quote`. Mention people as `<@U0123ABCD>` and channels as
`<#C0123ABCD>`. Look up the IDs first; plain `@name` doesn't notify anyone.

## Reply in a thread

The simplest way is to send to the **message link**, which replies in that message's thread:

```bash
slacker --json send https://acme.slack.com/archives/C0123ABCD/p1700000000123456 --dry-run "On it"
```

Or give the channel and the parent's ts: `slacker send general -t 1700000000.123456 "On it"`.
`--broadcast` / `also_send_to_channel: true` also posts the reply to the channel. Use it only when the
user asks.

## Edit, delete, react

These take the message link (or a channel plus `--ts` / `ts`), and only work on the user's own messages
(react works on anyone's):

```bash
slacker --json edit <link> "corrected text"     # replaces the whole text; the old text is lost
slacker --json delete <link> --yes              # permanent; --yes is required without a terminal
slacker --json react <link> eyes
```

MCP: `edit_message { target, ts, text }`, `delete_message { target, ts }`,
`add_reaction { target, ts, emoji }`.

Delete can't be undone, so confirm with the user right before running it, even if they asked earlier in
the conversation. Show them which message it is. Through the CLI you never have a terminal, so you must pass
`--yes` and slacker's own `[y/N]` question never appears: your confirmation with the user is the only one.
The MCP `delete_message` tool doesn't ask either.

## Status

```bash
slacker --json status --set "In a meeting" --emoji :calendar: --expires 60
slacker --json status --clear
```

MCP: `set_status { text, emoji, expires_in_minutes }`. Pass empty `text` and `emoji` to clear. Setting
a status replaces the current one.

## When slacker refuses a write

These refusals protect the user. Report them; don't work around them.

How to tell which error you got:

- **CLI with `--json`:** errors print `{"error": {"message", "code", "hint"}}`. Match on `error.code`.
- **MCP:** a failed tool call returns plain text (`isError`) with no code. Match on the message text; the
  table gives a phrase to look for.

| Code (CLI) | Message contains | Meaning | What to do |
| --- | --- | --- | --- |
| `untrusted_project` | `Refusing to write: … .slacker.json` | A `.slacker.json` the user hasn't trusted picked the workspace, or someone else controls one | Show the user the error, and the file and workspace it names. Ask them to check the workspace and run `slacker trust` in that project themselves. **Never** run `slacker trust` or `slacker init`, or add `-w`, yourself |
| `project_changed` | `now picks` / `no .slacker.json picks it any more` | The `.slacker.json` changed after the server (or command) started | Tell the user. Over MCP they restart the server (`/mcp` → reconnect); in the CLI, run the command again only if the user confirms the workspace |
| `unsafe_symlink` | `is a symlink` (from `init`) | `.slacker.json` or `.mcp.json` is a symlink leading outside the project, or one that dangles | Tell the user. Don't rerun `init` or replace the link yourself |
| `workspace_alias` | `shares credentials with` | Two config names point at the same Slack team, so slacker can't be sure which one is meant | Tell the user. Fix: [duplicated workspace entries](https://github.com/manasnilorout/slacker/blob/main/docs/reference.md#fixing-duplicated-workspace-entries) |
| `team_unverified` | `has no teamId in config.json` | The config entry has no team ID to check against | Ask the user to run `slacker auth setup`, which re-imports the workspace with its team (`auth refresh` can't fix this) |
| `team_mismatch` | `but its credentials sign in to` | The credentials now sign in to a different team than the config says | Stop. Ask the user to run `slacker auth setup`, or `slacker auth remove <name>` |
| `channel_not_found` | `No channel named` | No channel by that name (bare names never match people) | Use `list_channels` / `find_user` and ask which one was meant |
| `ambiguous_user` / `user_not_found` | `Close matches` / `No Slack user matches` | The person couldn't be pinned down exactly | Show the candidates and ask |
| `directory_too_large` | `too large to` | The workspace is too big to find the channel or person by name | Ask for the channel ID (`C…`), a link, the user ID or an email |
| `invalid_target` | `No target given`, `No channel name given`, `broadcast mention` | Empty target, or `@here`/`@channel`/`@everyone` as a person | Ask for a real channel or person |
| `cross_workspace_link` | `That link is from` | The link belongs to a different workspace | Use the right workspace (`-w <name>` in the CLI), or ask |
| `missing_ts` / `invalid_ts` | `Provide the` … `ts` / `is not a Slack message ts` | Edit, delete, react or thread needs a message | Pass a message link, or a ts like `1700000000.123456` |
| `broadcast_without_thread` | `only applies to thread replies` | `--broadcast` / `also_send_to_channel` without a thread | Add the thread ts or a message link, or drop the broadcast |
| `confirmation_required` | `Pass --yes` | CLI `delete` without a terminal | Confirm with the user first, then pass `--yes` |
| `unquoted_text` | `Quote the message` | CLI `send`/`edit` text wasn't one quoted argument | Quote the text (use `--` before text starting with `-`) |
| `read_only` | `this project is read-only` / `is now read-only` | The project was set up with `--read-only`, or `SLACKER_READ_ONLY` is set | Don't write. Tell the user. Over MCP the write tools are normally missing; you only see this error if the project became read-only after the server started |

**"NOT sent"** (or, for edits, deletes, reactions and status, **"NOT made"**) means nothing happened: Slack
rate-limited the request and slacker gave up, or the connection never opened. It's safe to try again later.
**"may or may not have been posted"** (or **"may or may not have been made"**) means the outcome is unknown,
for example after a timeout or a reset mid-request, or when Slack answered `fatal_error`, `internal_error`,
`request_timeout` or `service_unavailable` ("Slack had an internal problem"). Don't resend. Read the
conversation to check, and tell the user.
