# Reading Slack

All of these are read-only. With the CLI, add `--json` (before or after the command) for structured
output. Errors then come back as `{"error": {"message", "code", "hint"}}`.

## Read a channel or DM

```bash
slacker --json read general -n 20 --since 1d
slacker --json read @alice -n 10            # your DM with alice
slacker --json read C0123ABCD --since 2026-09-01 --until 2026-09-02
```

MCP: `read_messages { target, limit, oldest, latest, cursor }`.

The result has `channel`, `count`, `messages` (oldest first) and `nextCursor`, which is non-null when
older messages exist; pass it back as `--cursor` / `cursor` for the next page. Each message has `ts`,
`time` (ISO), `user`, `userId`, `text` with mentions resolved to names, and when they apply:
`threadTs`, `replyCount`, `reactions`, `files`, `edited`, `botId`, `subtype`.

A `note` field means Slack limited the history (free plans hide older messages).

## Read a thread

```bash
slacker --json thread https://acme.slack.com/archives/C0123ABCD/p1700000000123456
slacker --json thread general 1700000000.123456
```

MCP: `read_thread { target, ts, limit, cursor }`. `ts` is optional when `target` is a message link; a link
to a reply opens its whole thread.

The first message is the parent. Follow `nextCursor` while `hasMore` is true to get the rest of a long
thread. Use this for any message with a `replyCount`.

## Unread

```bash
slacker --json unread -n 30
```

MCP: `list_unread { limit }`. Returns `total`, `threadsHaveUnreads`, `threadMentions` and
`conversations`, sorted by mentions and then by latest activity. Each conversation has `id`, `name`,
`type` (`channel`, `private_channel`, `dm` or `group_dm`), `mentions` and `latest`.

## Channels

```bash
slacker --json channels                 # channels you're in
slacker --json channels -f deploy       # name contains "deploy"
slacker --json channels --all -f eng    # browse all public channels
```

MCP: `list_channels { joined_only, query, limit, cursor }`. Use this when a bare channel name isn't
found: show the user the close matches and ask which one they meant.

## People

```bash
slacker --json find "alice smith"
slacker --json find alice@example.com
slacker --json users -n 100            # list everyone (paged)
```

MCP: `find_user { query, limit }`. Use the returned user ID to DM someone (`U…` as the target) or to
mention them in a message (`<@U…>`). If several people match, ask the user. Don't pick one.

## Status

```bash
slacker --json status           # yours
slacker --json status @alice    # someone else's
```

MCP: `get_status { user }`. Returns `statusText`, `statusEmoji`, `statusExpires` and `presence`.

## Which workspace

```bash
slacker --json whoami
```

MCP: `whoami`. Returns the workspace name, team, user, how the workspace was chosen (`source`: `flag`
for `--workspace`, `env` for `SLACKER_WORKSPACE`, `project` for `.slacker.json`, or `default`), whether the project is
read-only, and any warnings. Check it before the first write in a session, and whenever the user has
more than one workspace.

- MCP servers registered by `slacker init` always pass `--workspace`, so MCP `whoami` normally reports
  `source: "flag"`, even in a project with a `.slacker.json`.
- `projectFile` is the `.slacker.json` found, and `projectTrusted` says whether the user trusted it for its
  workspace (`true`/`false`, or `null` when there's no file naming a workspace). With `source: "project"` and
  `projectTrusted: false`, reads work but writes are refused (`untrusted_project`).
- `ignoredProjectFile` names a `.slacker.json` that slacker ignored because someone else could change it
  (another owner, writable by group or others, or in a directory others can write to). Writes are refused
  while it's there.
- Over MCP, `projectFile`, `projectTrusted` and `ignoredProjectFile` show the state at the time of the call;
  `source` is how the server's workspace was chosen when it started.
- A CLI read that uses an untrusted `.slacker.json` still works, and prints one warning line on stderr.
  Tell the user if you see it; don't run `slacker trust` yourself.
