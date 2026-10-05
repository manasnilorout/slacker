import { describe, it, expect, afterEach, afterAll, beforeEach, vi } from "vitest";
import { SlackApiError } from "../src/api.js";
import { SlackSession, toSlackTs } from "../src/session.js";
import { SlackerError } from "../src/errors.js";
import { setActiveConfig } from "../src/command.js";
import { installSlackStub, paginate, makeUser, restoreAll, slackError, writeTempConfig, SlackStub } from "./helpers/slackStub.js";

// Non-UTC zone so "local midnight" bugs show up; expectations are computed with local Date anyway.
process.env.TZ = "America/New_York";

const cfg = writeTempConfig(
  {
    work: {},
    other: { teamId: "T0OTHER01", url: "https://other.slack.com/" },
    // Two names for one team (a copy-pasted entry) and an entry without a recorded team.
    dupa: { teamId: "T0DUP0001", url: "https://dup.slack.com/" },
    dupb: { teamId: "T0DUP0001", url: "https://dup.slack.com/" },
    noteam: { teamId: "" },
  },
  "work"
);
const DUP_IDENTITY = { team: "Dup", team_id: "T0DUP0001", url: "https://dup.slack.com/" };
afterAll(() => cfg.cleanup());
afterEach(restoreAll);

const GENERAL = { id: "C0GENERAL1", name: "general" };
const ENG = { id: "C0ENGENG01", name: "eng-platform", is_private: true };
const people = [makeUser("U0AAAAAA1", "alice", "Alice Archer"), makeUser("U0BOBBOB1", "bob", "Bob General")];

/** A small workspace: two joined channels, two people, channel info for both. */
function workspace(opts: Parameters<typeof installSlackStub>[0] = {}): SlackStub {
  const byId = new Map([GENERAL, ENG].map((c) => [c.id, c]));
  return installSlackStub(opts)
    .on("users.conversations", (p) => paginate([GENERAL, ENG], "channels", p))
    .on("conversations.list", (p) => paginate([GENERAL], "channels", p))
    .on("conversations.info", (p) =>
      byId.has(p.channel)
        ? { channel: byId.get(p.channel) }
        : p.channel.startsWith("D")
          ? { channel: { id: p.channel, is_im: true, user: "U0BOBBOB1" } }
          : slackError("channel_not_found")
    )
    .on("search.modules", (p) => ({
      items: people.filter((u) => JSON.stringify(u).toLowerCase().includes(p.query.toLowerCase())),
    }))
    .on("users.info", (p) => {
      const u = people.find((x) => x.id === p.user);
      return u ? { user: u } : slackError("user_not_found");
    });
}

const session = (name?: string, now?: () => number) =>
  new SlackSession(name, cfg.file, { api: { maxRetries: 0 }, ...(now && { resolver: { now } }) });
const posted = (slack: SlackStub) => slack.callsTo("chat.postMessage").map((c) => c.params);
const LINK = "https://work.slack.com/archives/C0GENERAL1/p1700000000123456";

describe("sendMessage threading (P0-1)", () => {
  it("replies in the thread of a top-level message link", async () => {
    const slack = workspace();
    const r = await session().sendMessage({ target: LINK, text: "on it" });
    expect(posted(slack)).toEqual([expect.objectContaining({ channel: "C0GENERAL1", thread_ts: "1700000000.123456", text: "on it" })]);
    expect(r).toMatchObject({ sent: true, threadTs: "1700000000.123456", ts: "1760000000.000100" });
  });

  it("replies to the parent for a thread-reply link", async () => {
    const slack = workspace();
    await session().sendMessage({ target: `${LINK.replace("p1700000000123456", "p1700000099000001")}?thread_ts=1700000000.123456`, text: "x" });
    expect(posted(slack)[0].thread_ts).toBe("1700000000.123456");
  });

  it("explicit threadTs wins over the link", async () => {
    const slack = workspace();
    await session().sendMessage({ target: LINK, text: "x", threadTs: "1700000555.000001" });
    expect(posted(slack)[0].thread_ts).toBe("1700000555.000001");
  });

  it("a channel link or name posts top-level", async () => {
    const slack = workspace();
    await session().sendMessage({ target: "https://work.slack.com/archives/C0GENERAL1", text: "x" });
    await session().sendMessage({ target: "#general", text: "y" });
    expect(posted(slack).map((p) => p.thread_ts)).toEqual([undefined, undefined]);
  });

  it("alsoSendToChannel without a thread is an error, with a thread broadcasts", async () => {
    const slack = workspace();
    await expect(session().sendMessage({ target: "#general", text: "x", alsoSendToChannel: true })).rejects.toThrow(/only applies to thread replies/);
    await session().sendMessage({ target: LINK, text: "x", alsoSendToChannel: true });
    expect(posted(slack)).toEqual([expect.objectContaining({ reply_broadcast: "true" })]);
  });

  it("rejects empty text and malformed thread ts", async () => {
    const slack = workspace();
    await expect(session().sendMessage({ target: "#general", text: "  " })).rejects.toThrow(/empty/);
    await expect(session().sendMessage({ target: "#general", text: "x", threadTs: "yesterday" })).rejects.toThrow(/not a Slack message ts/);
    expect(slack.count("chat.postMessage")).toBe(0);
  });
});

describe("write results and dry run (D4)", () => {
  it("dryRun resolves and verifies but never posts", async () => {
    const slack = workspace();
    const r = await session().sendMessage({ target: "#eng-platform", text: "deploy done", dryRun: true });
    expect(slack.count("chat.postMessage")).toBe(0);
    expect(slack.count("auth.test")).toBe(1);
    expect(r).toEqual({
      sent: false,
      dryRun: true,
      workspace: "work",
      team: "Work",
      teamDomain: "work.slack.com",
      destination: { id: "C0ENGENG01", type: "private_channel", name: "#eng-platform" },
      channel: "C0ENGENG01",
      threadTs: null,
    });
  });

  it("dryRun against an unknown channel ID fails instead of looking fine", async () => {
    const slack = workspace();
    await expect(session().sendMessage({ target: "C0MISSING1", text: "x", dryRun: true })).rejects.toMatchObject({
      code: "channel_not_found",
    });
    expect(slack.count("chat.postMessage")).toBe(0);
  });

  it("DM destinations name the person", async () => {
    workspace();
    const r = await session().sendMessage({ target: "@bob", text: "hi" });
    expect(r.destination).toMatchObject({ type: "dm", name: "@bob (Bob General)" });
    expect(r.permalink).toMatch(/^https:\/\/work\.slack\.com\//);
  });

  it("edit/delete/react carry workspace, team and destination", async () => {
    workspace();
    const s = session();
    const ctx = { workspace: "work", team: "Work", destination: { id: "C0GENERAL1", type: "channel", name: "#general" } };
    expect(await s.editMessage({ target: LINK, text: "fixed" })).toMatchObject({ edited: true, ...ctx, ts: "1700000000.123456" });
    expect(await s.deleteMessage({ target: LINK })).toMatchObject({ deleted: true, ...ctx, ts: "1700000000.123456" });
    expect(await s.addReaction({ target: LINK, emoji: ":eyes:" })).toMatchObject({ reacted: true, ...ctx, emoji: "eyes" });
    await expect(s.deleteMessage({ target: "#general" })).rejects.toThrow(/Provide the message ts/);
  });
});

describe("target resolution never guesses a person (P0-2)", () => {
  it.each(["#genral", "genral", "@bo", "@here", "bob general"])("%s", async (target) => {
    const slack = workspace();
    await expect(session().sendMessage({ target, text: "deploy done" })).rejects.toThrow();
    expect(slack.count("conversations.open")).toBe(0);
    expect(slack.count("chat.postMessage")).toBe(0);
  });

  it("an exact @handle opens the DM", async () => {
    const slack = workspace();
    await session().sendMessage({ target: "@alice", text: "hi" });
    expect(slack.callsTo("conversations.open")[0].params.users).toBe("U0AAAAAA1");
    expect(slack.count("chat.postMessage")).toBe(1);
  });

  it("a bare name that is a person suggests the @handle", async () => {
    workspace();
    await expect(session().readMessages({ target: "alice" })).rejects.toThrow(/No channel named "#alice".*Did you mean "@alice"/);
  });

  it.each(["invalid_auth", "ratelimited"])("%s during resolution surfaces the Slack error", async (code) => {
    workspace().fail("users.conversations", code);
    const err = await session().readMessages({ target: "#general" }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe(code);
  });
});

describe("workspace identity (D3)", () => {
  it("whoami reports aliases sharing the team", async () => {
    workspace({ identity: DUP_IDENTITY });
    expect(await session("dupa").whoami()).toMatchObject({ workspace: "dupa", team: "Dup", teamId: "T0DUP0001", aliases: ["dupb"] });
    expect((await session().whoami()).aliases).toEqual([]);
  });

  it("blocks writes when the credentials sign in to another team", async () => {
    const slack = workspace({ identity: { team: "Elsewhere", team_id: "T0ELSE001" } });
    await expect(session().sendMessage({ target: "#general", text: "x" })).rejects.toThrow(
      'Workspace "work" is configured for team T0WORK001 but its credentials sign in to "Elsewhere" (T0ELSE001).'
    );
    await expect(session().sendMessage({ target: "#general", text: "x", allowAlias: true })).rejects.toMatchObject({
      code: "team_mismatch",
    });
    await expect(session().setStatus({ text: "away" })).rejects.toThrow(/configured for team/);
    expect(slack.methods()).toEqual(["auth.test", "auth.test", "auth.test"]);
  });

  it("caches the identity check per credentials", async () => {
    const slack = workspace();
    const s = session();
    await s.sendMessage({ target: "#general", text: "a" });
    await s.sendMessage({ target: "#general", text: "b" });
    expect(slack.count("auth.test")).toBe(1);
  });
});

describe("links from another workspace (P2-3)", () => {
  it("errors naming both domains", async () => {
    const slack = workspace();
    await expect(session().readThread({ target: "https://acme.slack.com/archives/C0GENERAL1/p1700000000123456" })).rejects.toThrow(
      /link is from acme\.slack\.com, but workspace "work" is work\.slack\.com/
    );
    expect(slack.count("conversations.replies")).toBe(0);
  });

  it("allows any slack.com host on Enterprise Grid", async () => {
    const slack = workspace({ identity: { enterprise_id: "E0GRID001" } });
    await session().readThread({ target: "https://acme.slack.com/archives/C0GENERAL1/p1700000000123456" });
    await session().readThread({ target: "https://org.enterprise.slack.com/archives/C0GENERAL1/p1700000000123456" });
    expect(slack.count("conversations.replies")).toBe(2);
  });
});

describe("readThread pagination (P1-7)", () => {
  it("passes the cursor and reports nextCursor/hasMore", async () => {
    const replies = Array.from({ length: 5 }, (_, i) => ({ ts: `170000000${i}.000001`, user: "U0AAAAAA1", text: `r${i}` }));
    const slack = workspace().on("conversations.replies", (p) => {
      const page = paginate(replies, "messages", p, 2);
      return { ...page, has_more: !!page.response_metadata.next_cursor };
    });
    const s = session();
    const texts: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await s.readThread({ target: LINK, limit: 2, cursor });
      texts.push(...r.messages.map((m) => m.text as string));
      expect(r.hasMore).toBe(!!r.nextCursor);
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    expect(texts).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(slack.callsTo("conversations.replies").map((c) => c.params.cursor)).toEqual([undefined, "2", "4"]);
  });
});

describe("listChannels with a filter (P1-6)", () => {
  const all = Array.from({ length: 2500 }, (_, i) => ({ id: `C${String(i).padStart(8, "0")}`, name: i % 100 === 0 ? `eng-${i}` : `misc-${i}` }));

  it("pages at full size and never skips matches", async () => {
    const slack = installSlackStub().on("conversations.list", (p) => paginate(all, "channels", p));
    const s = session();
    const seen: string[] = [];
    let cursor: string | undefined;
    let rounds = 0;
    do {
      const r = await s.listChannels({ joinedOnly: false, query: "eng", limit: 10, cursor });
      seen.push(...r.channels.map((c) => c.name));
      cursor = r.nextCursor ?? undefined;
      rounds++;
    } while (cursor && rounds < 10);
    expect(seen).toEqual(all.filter((c) => c.name.startsWith("eng")).map((c) => c.name));
    expect(slack.callsTo("conversations.list").every((c) => c.params.limit === "1000")).toBe(true);
  });

  it("returns limit matches with truncated and no cursor when a page overflows", async () => {
    installSlackStub().on("conversations.list", (p) => paginate(all, "channels", p));
    const r = await session().listChannels({ joinedOnly: false, query: "eng", limit: 5 });
    expect(r).toMatchObject({ count: 5, nextCursor: null, truncated: true });
  });

  it("without a filter uses limit as page size and passes the cursor through", async () => {
    const slack = installSlackStub().on("users.conversations", (p) => paginate(all, "channels", p));
    const r = await session().listChannels({ limit: 50 });
    expect(r).toMatchObject({ count: 50, nextCursor: "50" });
    expect(slack.callsTo("users.conversations")[0].params.limit).toBe("50");
  });
});

describe("findUsers (P2-17)", () => {
  it("lists active humans without a query, with nextCursor", async () => {
    const members = [
      ...people,
      makeUser("U0GONE001", "gone", "Gone", { deleted: true }),
      makeUser("U0BOT0001", "bot", "Bot", { is_bot: true }),
      makeUser("USLACKBOT", "slackbot"),
    ];
    installSlackStub().on("users.list", (p) => paginate(members, "members", p, 5));
    const r = await session().findUsers({});
    expect(r.users.map((u) => u.username)).toEqual(["alice", "bob"]);
    expect(r.nextCursor).toBeNull();
  });

  it("searches with a query", async () => {
    workspace();
    expect((await session().findUsers({ query: "ali" })).users.map((u) => u.id)).toEqual(["U0AAAAAA1"]);
  });
});

describe("searchMessages (P2-18)", () => {
  it("names DM counterparts and authors", async () => {
    workspace().on("search.messages", () => ({
      messages: {
        total: 2,
        matches: [
          { ts: "1700000000.000001", user: "U0AAAAAA1", text: "hi <@U0BOBBOB1>", channel: { id: "D0DM12345", is_im: true } },
          { ts: "1700000001.000001", user: "U0BOBBOB1", text: "yo", channel: { id: "C0GENERAL1", name: "general" } },
        ],
      },
    }));
    const r = await session().searchMessages({ query: "hi" });
    expect(r.matches.map((m) => [m.channel, m.channelType, m.user, m.text])).toEqual([
      ["@bob", "dm", "alice", "hi @bob"],
      ["#general", "channel", "bob", "yo"],
    ]);
  });
});

describe("listUnread (P1-8)", () => {
  it("bounds concurrency and names conversations", async () => {
    const ims = Array.from({ length: 40 }, (_, i) => ({ id: `D0${String(i).padStart(7, "0")}`, has_unreads: true, latest: "1700000000.000001" }));
    const slack = workspace({ delayMs: 3 }).on("client.counts", () => ({
      channels: [{ id: "C0GENERAL1", mention_count: 2, has_unreads: true, latest: "1700000000.000001" }],
      ims,
    }));
    const r = await session().listUnread({ limit: 41 });
    expect(r.conversations[0]).toMatchObject({ id: "C0GENERAL1", name: "#general", mentions: 2, type: "channel" });
    expect(r.conversations[1]).toMatchObject({ type: "dm", name: "@bob (Bob General)" });
    expect(slack.maxInFlight).toBeLessThanOrEqual(6);
    expect(slack.count("users.info")).toBe(1);
  });
});

describe("setStatus (P2-9)", () => {
  let slack: SlackStub;
  beforeEach(() => {
    slack = workspace();
  });

  it.each([["eyes"], [":eyes"], ["eyes:"], ["::eyes::"]])("normalizes %s", async (emoji) => {
    const r = await session().setStatus({ text: "reviewing", emoji });
    expect(r.emoji).toBe(":eyes:");
    expect(JSON.parse(slack.callsTo("users.profile.set")[0].params.profile).status_emoji).toBe(":eyes:");
  });

  it.each([-1, 1.5, 525_601, 1e12])("rejects expiry %s before calling Slack", async (expiresInMinutes) => {
    await expect(session().setStatus({ text: "x", expiresInMinutes })).rejects.toThrow(/whole number of minutes/);
    expect(slack.count("users.profile.set")).toBe(0);
  });

  it("returns the expiry and workspace", async () => {
    const r = await session().setStatus({ text: "lunch", expiresInMinutes: 525_600 });
    expect(r).toMatchObject({ status: "set", workspace: "work", team: "Work" });
    expect(Date.parse(r.expires!)).toBeGreaterThan(Date.now());
  });
});

describe("toSlackTs (P2-1)", () => {
  const now = new Date(2026, 9, 5, 15, 30, 0); // local time
  const secs = (d: Date | number) => (Number(d) / 1000).toFixed(6);

  it.each([
    ["1700000000", "1700000000"],
    ["1700000000.123", "1700000000.123"],
    ["999999999", "999999999"],
    ["2026-10-01", secs(new Date(2026, 9, 1))],
    ["  2026-10-01 ", secs(new Date(2026, 9, 1))],
    ["2026-10-01T09:30", secs(new Date(2026, 9, 1, 9, 30))],
    ["2026-10-01 09:30:15", secs(new Date(2026, 9, 1, 9, 30, 15))],
    ["2026-10-01T00:00Z", secs(Date.UTC(2026, 9, 1))],
    ["2026-10-01T00:00:00.000+05:30", secs(Date.UTC(2026, 8, 30, 18, 30))],
    ["2024-02-29", secs(new Date(2024, 1, 29))],
    ["now", secs(now)],
    ["today", secs(new Date(2026, 9, 5))],
    ["yesterday", secs(new Date(2026, 9, 4))],
    ["30m", secs(now.getTime() - 30 * 60_000)],
    ["2h", secs(now.getTime() - 2 * 3_600_000)],
    ["7d", secs(now.getTime() - 7 * 86_400_000)],
    ["1w", secs(now.getTime() - 7 * 86_400_000)],
    ["3 days ago".replace("days", "d"), secs(now.getTime() - 3 * 86_400_000)],
  ])("%s", (input, expected) => {
    expect(toSlackTs(input, now)).toBe(expected);
  });

  it.each(["2026", "20261001", "-1", "0", "1e9", "1700000000.", "2026-02-30", "2025-02-29", "2026-13-01", "2026-10-01T25:00", "March 7", "10/01/2026", "soon"])(
    "rejects %s",
    (input) => {
      expect(() => toSlackTs(input, now)).toThrow(/Could not parse time/);
    }
  );

  it("passes through empty values", () => {
    expect(toSlackTs(undefined)).toBeUndefined();
    expect(toSlackTs("  ")).toBeUndefined();
  });

  it("readMessages rejects a bad time before calling Slack", async () => {
    const slack = workspace();
    await expect(session().readMessages({ target: "#general", oldest: "2026-02-30" })).rejects.toThrow(/Could not parse time/);
    expect(slack.count()).toBe(0);
  });
});

describe("aliased and unverified workspaces (R1)", () => {
  const DUP_LINK = "https://dup.slack.com/archives/C0GENERAL1/p1700000000123456";
  const writes = (s: SlackSession, link: string, extra: { allowAlias?: boolean } = {}) => [
    () => s.sendMessage({ target: "#general", text: "x", ...extra }),
    () => s.sendMessage({ target: "#general", text: "x", dryRun: true, ...extra }),
    () => s.editMessage({ target: link, text: "x", ...extra }),
    () => s.deleteMessage({ target: link, ...extra }),
    () => s.addReaction({ target: link, emoji: "eyes", ...extra }),
    () => s.setStatus({ text: "x", ...extra }),
  ];

  it("refuses every write, dry run included, naming the live team and the fix", async () => {
    const slack = workspace({ identity: DUP_IDENTITY });
    for (const write of writes(session("dupa"), DUP_LINK)) {
      const err = await write().catch((e) => e);
      expect(err).toBeInstanceOf(SlackerError);
      expect(err.code).toBe("workspace_alias");
      expect(err.message).toContain('Workspace "dupa" shares credentials with "dupb" (both sign in to team "Dup"). Refusing to write');
      expect(err.message).toMatch(/: slacker auth list → slacker auth remove <copy> → slacker auth setup\. To write anyway \(CLI only\) pass --allow-alias\.(\n\(run slacker as: .+\))?$/);
    }
    expect(slack.methods().filter((m) => m !== "auth.test")).toEqual([]);
  });

  it("fix hints carry -c for a non-default config", async () => {
    workspace({ identity: DUP_IDENTITY });
    setActiveConfig(cfg.file);
    try {
      const err = await session("dupa").sendMessage({ target: "#general", text: "x", dryRun: true }).catch((e) => e);
      expect(err.message).toContain(`-c "${cfg.file}"`);
    } finally {
      setActiveConfig(undefined);
    }
  });

  it("allowAlias lets each write through", async () => {
    const slack = workspace({ identity: DUP_IDENTITY });
    for (const write of writes(session("dupa"), DUP_LINK, { allowAlias: true })) await write();
    expect(["chat.postMessage", "chat.update", "chat.delete", "reactions.add", "users.profile.set"].map((m) => slack.count(m))).toEqual([
      1, 1, 1, 1, 1,
    ]);
  });

  it("refuses writes when config.json has no teamId (team_unverified), bypassable with allowAlias", async () => {
    const slack = workspace();
    for (const write of writes(session("noteam"), LINK)) {
      await expect(write()).rejects.toMatchObject({ code: "team_unverified", message: expect.stringMatching(/has no teamId.*auth setup.*--allow-alias/) });
    }
    expect(slack.methods().filter((m) => m !== "auth.test")).toEqual([]);
    await session("noteam").sendMessage({ target: "#general", text: "x", allowAlias: true });
    expect(slack.count("chat.postMessage")).toBe(1);
  });

  it("reads are not affected", async () => {
    workspace({ identity: DUP_IDENTITY });
    await expect(session("dupa").readMessages({ target: "#general" })).resolves.toMatchObject({ channel: "C0GENERAL1" });
  });
});

describe("validation before any network call; dry runs have no side effects (R2)", () => {
  it("a dry run to a person resolves them without opening the DM", async () => {
    const slack = workspace();
    const r = await session().sendMessage({ target: "@bob", text: "hi", dryRun: true });
    expect(r).toMatchObject({
      sent: false,
      dryRun: true,
      channel: null,
      destination: { id: null, type: "dm", name: "@bob (Bob General)", userId: "U0BOBBOB1" },
    });
    expect(slack.count("conversations.open")).toBe(0);
    expect(slack.count("chat.postMessage")).toBe(0);
    // The real send opens it.
    const sent = await session().sendMessage({ target: "@bob", text: "hi" });
    expect(sent.destination).toMatchObject({ type: "dm", name: "@bob (Bob General)" });
    expect(slack.count("conversations.open")).toBe(1);
  });

  it("a dry run to an unknown user ID fails", async () => {
    const slack = workspace();
    await expect(session().sendMessage({ target: "U0NOBODY1", text: "hi", dryRun: true })).rejects.toMatchObject({ code: "user_not_found" });
    expect(slack.count("conversations.open")).toBe(0);
  });

  it.each([
    ["broadcast without a thread", (s: SlackSession) => s.sendMessage({ target: "#general", text: "x", alsoSendToChannel: true }), "broadcast_without_thread"],
    ["bad thread ts", (s: SlackSession) => s.sendMessage({ target: "#general", text: "x", threadTs: "yesterday" }), "invalid_ts"],
    ["empty text", (s: SlackSession) => s.sendMessage({ target: "#general", text: " " }), "invalid_argument"],
    ["empty target", (s: SlackSession) => s.sendMessage({ target: " ", text: "x" }), "invalid_target"],
    ["edit without ts", (s: SlackSession) => s.editMessage({ target: "#general", text: "x" }), "missing_ts"],
    ["delete without ts", (s: SlackSession) => s.deleteMessage({ target: "#general" }), "missing_ts"],
    ["react without ts", (s: SlackSession) => s.addReaction({ target: "@bob", emoji: "eyes" }), "missing_ts"],
    ["react with a bad ts", (s: SlackSession) => s.addReaction({ target: "#general", ts: "123", emoji: "eyes" }), "invalid_ts"],
    ["thread without ts", (s: SlackSession) => s.readThread({ target: "#general" }), "missing_ts"],
    ["bad status expiry", (s: SlackSession) => s.setStatus({ text: "x", expiresInMinutes: -1 }), "invalid_status"],
    ["bad time", (s: SlackSession) => s.readMessages({ target: "#general", latest: "soon" }), "invalid_time"],
  ])("%s fails with zero API calls", async (_label, call, code) => {
    const slack = workspace();
    const err = await call(session()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackerError);
    expect(err).toMatchObject({ code });
    expect(slack.count()).toBe(0);
  });

  it("broadcast error names both option spellings", async () => {
    workspace();
    await expect(session().sendMessage({ target: "#general", text: "x", alsoSendToChannel: true })).rejects.toThrow(
      "--broadcast / also_send_to_channel only applies to thread replies. Pass a thread ts (--thread / thread_ts) or a message link."
    );
  });
});

describe("thread_ts and link forms (R8/R9)", () => {
  it("a thread_ts without a fraction is ignored in favour of the link's message ts", async () => {
    const slack = workspace();
    await session().sendMessage({ target: `${LINK}?thread_ts=1700000000`, text: "x" });
    expect(posted(slack)[0].thread_ts).toBe("1700000000.123456");
  });

  it("accepts app.slack.com/client links for this team, rejects other teams", async () => {
    const slack = workspace();
    const r = await session().sendMessage({
      target: "https://app.slack.com/client/T0WORK001/C0GENERAL1/thread/C0GENERAL1-1700000000.123456",
      text: "x",
    });
    expect(r).toMatchObject({ channel: "C0GENERAL1", threadTs: "1700000000.123456" });
    await expect(
      session().readMessages({ target: "https://app.slack.com/client/T0ELSE001/C0GENERAL1" })
    ).rejects.toMatchObject({ code: "cross_workspace_link", message: expect.stringMatching(/team T0ELSE001.*"Work" \(T0WORK001\)/) });
    expect(slack.count("conversations.history")).toBe(0);
  });

  it("<#C…|name> and #C0123ABCD targets are conversation IDs", async () => {
    const slack = workspace();
    await session().readMessages({ target: "<#C0GENERAL1|general>" });
    await session().readMessages({ target: "#C0GENERAL1" });
    expect(slack.callsTo("conversations.history").map((c) => c.params.channel)).toEqual(["C0GENERAL1", "C0GENERAL1"]);
    expect(slack.count("users.conversations")).toBe(0);
  });

  it("enterprise.slack.com links are refused outside Enterprise Grid", async () => {
    const slack = workspace();
    await expect(
      session().readThread({ target: "https://org.enterprise.slack.com/archives/C0GENERAL1/p1700000000123456" })
    ).rejects.toMatchObject({ code: "cross_workspace_link" });
    await expect(session().sendMessage({ target: "https://acme.slack.com/archives/C0GENERAL1", text: "x", dryRun: true })).rejects.toMatchObject({
      code: "cross_workspace_link",
    });
    expect(slack.count("conversations.replies")).toBe(0);
  });
});

describe("stale channel directory on name-based writes (R4)", () => {
  function renamable() {
    const chans = [
      { id: "C0RANDOM12", name: "random" },
      { id: "C0GENERAL1", name: "general" },
    ];
    const slack = installSlackStub()
      .on("users.conversations", (p) => paginate(chans, "channels", p))
      .on("conversations.list", (p) => paginate([], "channels", p))
      .on("conversations.info", (p) => {
        const ch = chans.find((c) => c.id === p.channel);
        return ch ? { channel: { ...ch } } : slackError("channel_not_found");
      });
    return { chans, slack };
  }

  it("a renamed channel is caught by a fresh conversations.info and the directory rescans", async () => {
    const { chans, slack } = renamable();
    const s = session();
    expect((await s.sendMessage({ target: "#random", text: "x", dryRun: true })).destination.id).toBe("C0RANDOM12");
    chans[0].name = "old-random";
    chans.push({ id: "C0NEWRAND1", name: "random" });
    const r = await s.sendMessage({ target: "#random", text: "x" });
    expect(r.destination).toEqual({ id: "C0NEWRAND1", type: "channel", name: "#random" });
    expect(posted(slack).map((p) => p.channel)).toEqual(["C0NEWRAND1"]);
    expect(slack.count("users.conversations")).toBe(2);
  });

  it("still mismatched after one rescan → channel_not_found, nothing written", async () => {
    const { slack } = renamable();
    slack.on("conversations.info", (p) => ({ channel: { id: p.channel, name: "something-else" } }));
    await expect(session().sendMessage({ target: "random", text: "x" })).rejects.toMatchObject({
      code: "channel_not_found",
      message: expect.stringMatching(/"#random" resolved to C0RANDOM12, but Slack now calls that channel #something-else/),
    });
    expect(slack.count("chat.postMessage")).toBe(0);
    expect(slack.count("users.conversations")).toBe(2);
  });

  it("a channel created after the last full scan is found once that scan is over 60s old", async () => {
    let now = 1_000_000;
    const { chans, slack } = renamable();
    const s = session(undefined, () => now);
    await expect(s.sendMessage({ target: "#launch", text: "x", dryRun: true })).rejects.toMatchObject({ code: "channel_not_found" });
    chans.push({ id: "C0LAUNCH01", name: "launch" });
    now += 61_000;
    const r = await s.sendMessage({ target: "#launch", text: "x", dryRun: true });
    expect(r.destination).toMatchObject({ id: "C0LAUNCH01", name: "#launch" });
    expect(slack.count("users.conversations")).toBe(2);
  });
});

describe("one client snapshot per write (R11)", () => {
  it("calls client() once", async () => {
    workspace();
    const s = session();
    const spy = vi.spyOn(s, "client");
    await s.sendMessage({ target: "#general", text: "x" });
    await s.setStatus({ text: "x" });
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("findUsers listing fills the limit (R13)", () => {
  const members = Array.from({ length: 40 }, (_, i) =>
    makeUser(`U0${String(i).padStart(7, "0")}`, `p${i}`, `P ${i}`, i % 2 ? { is_bot: true } : {})
  );

  it("fetches more pages (asking only for the remainder) and never skips anyone", async () => {
    const slack = installSlackStub().on("users.list", (p) => paginate(members, "members", p));
    const s = session();
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await s.findUsers({ limit: 7, cursor });
      expect(r.count).toBeLessThanOrEqual(7);
      seen.push(...r.users.map((u) => u.username!));
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(members.filter((u) => !("is_bot" in u)).map((u) => u.name));
    const first = slack.callsTo("users.list").slice(0, 3).map((c) => c.params.limit);
    expect(first).toEqual(["7", "3", "2"]);
  });

  it("stops after 5 pages with a cursor", async () => {
    const bots = members.map((u) => ({ ...u, is_bot: true }));
    const slack = installSlackStub().on("users.list", (p) => paginate(bots, "members", p));
    const r = await session().findUsers({ limit: 5 });
    expect(r).toMatchObject({ count: 0, users: [] });
    expect(r.nextCursor).toBeTruthy();
    expect(slack.count("users.list")).toBe(5);
  });
});

describe("listUnread archived marker (R13)", () => {
  it("marks archived conversations", async () => {
    workspace()
      .on("client.counts", () => ({ channels: [{ id: "C0OLDOLD01", has_unreads: true, latest: "1700000000.000001" }] }))
      .on("conversations.info", (p) => ({ channel: { id: p.channel, name: "old", is_archived: true } }));
    const r = await session().listUnread({});
    expect(r.conversations[0]).toMatchObject({ id: "C0OLDOLD01", name: "#old", archived: true });
  });
});

describe("round 3 (F4, F12)", () => {
  it("alias refusals say 'all' when more than two names share a team", async () => {
    const three = writeTempConfig({ a: { teamId: "T0DUP0001" }, b: { teamId: "T0DUP0001" }, c: { teamId: "T0DUP0001" } }, "a");
    try {
      installSlackStub({ identity: DUP_IDENTITY });
      const err = await new SlackSession("a", three.file).sendMessage({ target: "C0GENERAL1", text: "x", dryRun: true }).catch((e) => e);
      expect(err.code).toBe("workspace_alias");
      expect(err.message).toContain('shares credentials with "b", "c" (all sign in to team "Dup")');
    } finally {
      three.cleanup();
    }
  });

  it("an unknown workspace names how it was chosen", async () => {
    const s = new SlackSession("nope", cfg.file, { source: { source: "project", projectFile: "/repo/.slacker.json" } });
    expect(() => s.workspace()).toThrow('Workspace "nope" (from .slacker.json at /repo/.slacker.json) not found');
  });

  it("deleteMessage asks confirm after resolving, and a no cancels", async () => {
    const slack = workspace();
    const seen: string[] = [];
    const ask = async (w: { destination: { name: string }; ts: string; team: string }) => {
      seen.push(`${w.destination.name} ${w.ts} ${w.team}`);
      return false;
    };
    const err = await session().deleteMessage({ target: LINK, confirm: ask }).catch((e) => e);
    expect(err).toMatchObject({ code: "cancelled" });
    expect(seen).toEqual(["#general 1700000000.123456 Work"]);
    expect(slack.count("chat.delete")).toBe(0);
    const bad = await session().deleteMessage({ target: "#general", ts: "nope", confirm: ask }).catch((e) => e);
    expect(bad.code).toBe("invalid_ts");
    expect(seen).toHaveLength(1); // never asked
  });
});
