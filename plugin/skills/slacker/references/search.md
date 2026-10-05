# Searching Slack

```bash
slacker --json search "deploy failed" -n 20
slacker --json search "in:#eng from:@alice after:2026-09-01" --sort score
slacker --json search "has:link in:#releases" --page 2
```

MCP: `search_messages { query, limit, sort, page }`. `sort` is `timestamp` (newest first, the default)
or `score` (best match first).

The result has `total`, `page`, `pages` and `matches`. Each match has `channel` (`#name`, `@person` for
a DM, or `group DM`), `channelId`, `channelType`, `user`, `text`, `ts`, `time` and `permalink`. Pass the
permalink to `thread` / `read_thread` to read the conversation around a match.

## Modifiers

Slack's own search syntax goes in the query string:

| Modifier | Example | Matches |
| --- | --- | --- |
| `from:` | `from:@alice` | messages from a person |
| `in:` | `in:#eng`, `in:@alice` | messages in a channel or DM |
| `to:` | `to:@bob` | messages sent to a person |
| `has:` | `has:link`, `has:reaction`, `has:pin` | messages with that content |
| `before:` / `after:` / `on:` | `after:2026-09-01` | by date |
| `during:` | `during:september` | within a month or year |
| `"…"` | `"rollback plan"` | the exact phrase |
| `-word` | `deploy -staging` | excludes a word |

Quote the whole query as one shell argument, since `#` starts a comment in bash.

## Tips

- Start narrow (`in:` plus a date range) and widen if nothing comes back. `total` tells you how much
  there is.
- `from:@handle` needs the handle Slack knows the person by. If you only have a name, look it up with
  `find_user` / `slacker find` first.
- Search only covers conversations the user can see, and results can lag a few seconds behind new
  messages. Use `read` for the latest messages in a channel.
