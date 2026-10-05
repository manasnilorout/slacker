import { describe, it, expect, afterEach } from "vitest";
import { SlackAPI, SlackApiError } from "../src/api.js";
import { Resolver, parseSlackLink, parseTarget, CONVERSATION_ID, USER_ID } from "../src/resolve.js";
import { SlackerError } from "../src/errors.js";
import { createLimiter } from "../src/limit.js";
import { installSlackStub, paginate, makeUser, restoreAll, slackError } from "./helpers/slackStub.js";

afterEach(restoreAll);

const api = () => new SlackAPI("xoxc-test", "xoxd-test", { maxRetries: 0 });
const channels = (n: number, prefix = "chan") =>
  Array.from({ length: n }, (_, i) => ({ id: `C${String(i).padStart(8, "0")}`, name: `${prefix}-${i}` }));

describe("parseSlackLink", () => {
  it("parses message, thread and channel links and returns the host", () => {
    expect(parseSlackLink("https://acme.slack.com/archives/C0123ABCD/p1700000000123456")).toEqual({
      host: "acme.slack.com",
      channel: "C0123ABCD",
      ts: "1700000000.123456",
      threadTs: undefined,
    });
    expect(
      parseSlackLink("https://acme.slack.com/archives/C0123ABCD/p1700000099000001?thread_ts=1700000000.123456&cid=C0123ABCD")
    ).toMatchObject({ ts: "1700000099.000001", threadTs: "1700000000.123456" });
    expect(parseSlackLink("https://acme.slack.com/archives/C0123ABCD")).toEqual({
      host: "acme.slack.com",
      channel: "C0123ABCD",
      ts: undefined,
      threadTs: undefined,
    });
  });
  it("ignores thread_ts without a fraction and pads a short one", () => {
    expect(parseSlackLink("https://acme.slack.com/archives/C0123ABCD/p1700000099000001?thread_ts=1700000000")).toMatchObject({
      ts: "1700000099.000001",
      threadTs: undefined,
    });
    expect(parseSlackLink("https://acme.slack.com/archives/C0123ABCD/p1700000099000001?thread_ts=1700000000.5")?.threadTs).toBe(
      "1700000000.500000"
    );
  });
  it("accepts Slack-formatted <link|label> and enterprise hosts", () => {
    expect(parseSlackLink("<https://acme.slack.com/archives/C0123ABCD/p1700000000123456|msg>")?.ts).toBe("1700000000.123456");
    expect(parseSlackLink("https://acme.enterprise.slack.com/archives/C0123ABCD/p1700000000123456")?.host).toBe(
      "acme.enterprise.slack.com"
    );
  });
  it("parses app.slack.com/client links (channel, message, thread) with the team ID", () => {
    expect(parseSlackLink("https://app.slack.com/client/T0WORK001/C0123ABCD")).toEqual({
      host: "app.slack.com",
      channel: "C0123ABCD",
      ts: undefined,
      threadTs: undefined,
      teamId: "T0WORK001",
    });
    expect(parseSlackLink("https://app.slack.com/client/T0WORK001/C0123ABCD/thread/C0123ABCD-1700000000.123456")).toEqual({
      host: "app.slack.com",
      channel: "C0123ABCD",
      ts: "1700000000.123456",
      threadTs: "1700000000.123456",
      teamId: "T0WORK001",
    });
    expect(parseSlackLink("https://app.slack.com/client/E0GRID001/C0123ABCD/p1700000000123456/")).toMatchObject({
      channel: "C0123ABCD",
      ts: "1700000000.123456",
      teamId: "E0GRID001",
    });
    // Thread of a different channel, or no channel at all → not a link we understand.
    expect(parseSlackLink("https://app.slack.com/client/T0WORK001/C0123ABCD/thread/C0OTHER99-1700000000.123456")).toBeNull();
    expect(parseSlackLink("https://app.slack.com/client/T0WORK001")).toBeNull();
  });

  it("rejects non-Slack hosts, junk and malformed paths", () => {
    for (const bad of [
      "#general",
      "https://evil.example.com/archives/C0123ABCD/p1700000000123456",
      "https://slack.com.evil.dev/archives/C0123ABCD/p1700000000123456",
      "see https://acme.slack.com/archives/C0123ABCD/p1700000000123456 typo",
      "https://acme.slack.com/archives/C0123ABCD/p17000000001234567890",
      "https://acme.slack.com/archives/c0123abcd/p1700000000123456",
      "ftp://acme.slack.com/archives/C0123ABCD",
    ]) {
      expect(parseSlackLink(bad), bad).toBeNull();
    }
  });
});

describe("parseTarget", () => {
  it("treats <#C…|name> and #C0123ABCD as conversation IDs", async () => {
    expect(parseTarget("<#C0123ABCD|general>")).toEqual({ kind: "conversation", id: "C0123ABCD" });
    expect(parseTarget("<#C0123ABCD>")).toEqual({ kind: "conversation", id: "C0123ABCD" });
    expect(parseTarget(" #C0123ABCD ")).toEqual({ kind: "conversation", id: "C0123ABCD" });
    // Lowercase is a channel name, ID-less words too.
    expect(parseTarget("#c0123abcd")).toEqual({ kind: "channel", name: "c0123abcd", bare: false });
    expect(parseTarget("#GENERAL")).toEqual({ kind: "channel", name: "general", bare: false });
    expect(parseTarget("general")).toEqual({ kind: "channel", name: "general", bare: true });
    expect(parseTarget("@bob")).toEqual({ kind: "user", query: "@bob" });
    const slack = installSlackStub();
    expect(await new Resolver(api()).resolveConversation("<#C0123ABCD|general>")).toBe("C0123ABCD");
    expect(slack.count()).toBe(0);
  });

  it("throws SlackerError(invalid_target) for empty targets and non-Slack URLs", () => {
    for (const bad of ["  ", "#", "https://evil.example.com/archives/C0123ABCD"]) {
      const err = (() => {
        try {
          parseTarget(bad);
        } catch (e) {
          return e;
        }
      })();
      expect(err, bad).toBeInstanceOf(SlackerError);
      expect((err as SlackerError).code).toBe("invalid_target");
    }
  });
});

describe("ID patterns", () => {
  it("require a digit and at least 9 characters", () => {
    for (const word of ["GENERAL", "CHANGELOG", "WEBTEAM", "DEVOPSTEAM", "C1234567"]) expect(CONVERSATION_ID.test(word), word).toBe(false);
    for (const id of ["C0123ABCD", "D0DM12345", "G01234567"]) expect(CONVERSATION_ID.test(id), id).toBe(true);
    expect(USER_ID.test("WEBMASTER")).toBe(false);
    expect(USER_ID.test("U0AAAAAA1")).toBe(true);
  });
  it("routes uppercase words to the channel directory, not the API as IDs", async () => {
    const slack = installSlackStub().on("users.conversations", (p) =>
      paginate([{ id: "C0GENERAL", name: "general" }], "channels", p)
    );
    expect(await new Resolver(api()).resolveConversation("GENERAL")).toBe("C0GENERAL");
    expect(slack.methods()).toEqual(["users.conversations"]);
  });
});

describe("channel directory", () => {
  it("is page-capped and reports a too-large directory without trying people", async () => {
    const slack = installSlackStub()
      .on("users.conversations", (p) => paginate(channels(50, "joined"), "channels", p, 10))
      .on("conversations.list", (p) => paginate(channels(500), "channels", p, 10));
    const r = new Resolver(api(), { maxPages: 3, workspace: "work" });
    await expect(r.resolveConversation("#nope")).rejects.toThrow(/too large to search by name.*channel ID/);
    expect(slack.count("users.conversations")).toBe(3);
    expect(slack.count("conversations.list")).toBe(3);
    expect(slack.count("conversations.open")).toBe(0);
  });

  it("caches the directory and misses for the TTL, then rescans", async () => {
    let now = 1_000;
    const slack = installSlackStub()
      .on("users.conversations", (p) => paginate(channels(3, "joined"), "channels", p))
      .on("conversations.list", (p) => paginate(channels(5), "channels", p));
    const r = new Resolver(api(), { now: () => now, ttlMs: 60_000 });

    expect(await r.resolveConversation("#chan-4")).toBe("C00000004");
    expect(await r.resolveConversation("joined-1")).toBe("C00000001");
    await expect(r.resolveConversation("#typo")).rejects.toThrow(/No channel named "#typo"/);
    await expect(r.resolveConversation("#typo")).rejects.toThrow(/No channel named "#typo"/);
    expect(slack.count("users.conversations")).toBe(1);
    expect(slack.count("conversations.list")).toBe(1);

    now += 60_001;
    await expect(r.resolveConversation("#typo")).rejects.toThrow(/No channel/);
    expect(slack.count("users.conversations")).toBe(2);
  });

  it("resumes a partial scan instead of starting over", async () => {
    const slack = installSlackStub().on("users.conversations", (p) => paginate(channels(30), "channels", p, 10));
    const r = new Resolver(api());
    expect(await r.resolveConversation("chan-5")).toBe("C00000005");
    expect(await r.resolveConversation("chan-25")).toBe("C00000025");
    expect(slack.callsTo("users.conversations").map((c) => c.params.cursor ?? "")).toEqual(["", "10", "20"]);
  });

  it("dedupes concurrent scans", async () => {
    const slack = installSlackStub({ delayMs: 5 }).on("users.conversations", (p) => paginate(channels(20), "channels", p, 10));
    const r = new Resolver(api());
    const ids = await Promise.all(["chan-1", "chan-15", "chan-2"].map((n) => r.resolveConversation(n)));
    expect(ids).toEqual(["C00000001", "C00000015", "C00000002"]);
    expect(slack.count("users.conversations")).toBe(2);
  });

  it("skips sources that are unavailable to this session (D1 codes only)", async () => {
    installSlackStub()
      .fail("users.conversations", "missing_scope")
      .on("conversations.list", (p) => paginate(channels(3), "channels", p));
    expect(await new Resolver(api()).resolveConversation("#chan-2")).toBe("C00000002");
  });

  it.each(["invalid_auth", "ratelimited", "internal_error"])("surfaces %s instead of 'not found'", async (code) => {
    installSlackStub().fail("users.conversations", code);
    const err = await new Resolver(api()).resolveConversation("#general").catch((e) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect(err.code).toBe(code);
  });

  it("never falls back to a person for a channel name; suggests @handle on exact person match", async () => {
    const slack = installSlackStub().on("search.modules", () => ({ items: [makeUser("U0BOBBOB1", "bob", "Bob Smith")] }));
    const r = new Resolver(api(), { workspace: "work" });
    await expect(r.resolveConversation("bob")).rejects.toThrow(/No channel named "#bob" in workspace "work".*Did you mean "@bob"/);
    await expect(r.resolveConversation("#bob")).rejects.toThrow(/No channel named "#bob".*archived.*slacker channels/);
    await expect(r.resolveConversation("#bob")).rejects.toBeInstanceOf(SlackerError);
    expect(slack.count("conversations.open")).toBe(0);
  });

  it("skips the person suggestion when search.modules is unavailable (no users.list scan)", async () => {
    const slack = installSlackStub().fail("search.modules", "unknown_method");
    const err = await new Resolver(api()).resolveConversation("bob").catch((e) => e);
    expect(err).toMatchObject({ code: "channel_not_found" });
    expect(err.message).not.toMatch(/Did you mean/);
    expect(slack.count("users.list")).toBe(0);
  });

  it.each(["invalid_auth", "internal_error", "ratelimited"])("a failing suggestion (%s) never replaces the real error", async (code) => {
    installSlackStub().fail("search.modules", code);
    await expect(new Resolver(api()).resolveConversation("bob")).rejects.toMatchObject({
      code: "channel_not_found",
      message: expect.stringMatching(/No channel named "#bob"/),
    });
  });

  it("a miss after a joined-channels scan older than 60s rescans users.conversations once", async () => {
    let now = 1_000;
    const joined = [{ id: "C0GENERAL1", name: "general" }];
    const slack = installSlackStub().on("users.conversations", (p) => paginate(joined, "channels", p));
    const r = new Resolver(api(), { now: () => now });
    await expect(r.resolveConversation("#launch")).rejects.toMatchObject({ code: "channel_not_found" });
    joined.push({ id: "C0LAUNCH01", name: "launch" });
    now += 30_000;
    await expect(r.resolveConversation("#launch")).rejects.toMatchObject({ code: "channel_not_found" });
    expect(slack.count("users.conversations")).toBe(1);
    now += 31_000;
    expect(await r.resolveConversation("#launch")).toBe("C0LAUNCH01");
    expect(slack.count("users.conversations")).toBe(2);
    // The rescan just completed, so the next miss doesn't trigger another one.
    await expect(r.resolveConversation("#nope")).rejects.toMatchObject({ code: "channel_not_found" });
    expect(slack.count("users.conversations")).toBe(2);
    expect(slack.count("conversations.list")).toBe(1);
  });

  it("rejects empty targets and non-Slack URLs", async () => {
    installSlackStub();
    const r = new Resolver(api());
    await expect(r.resolveConversation("   ")).rejects.toThrow(/No target/);
    await expect(r.resolveConversation("https://evil.example.com/archives/C0123ABCD/p1700000000123456")).rejects.toThrow(
      /not a Slack message or channel link/
    );
  });
});

describe("user resolution", () => {
  const people = [makeUser("U0AAAAAA1", "alice", "Alice Archer"), makeUser("U0BOBBOB1", "bob", "Bob General")];

  it("rejects a single fuzzy match and lists candidates", async () => {
    const slack = installSlackStub().on("search.modules", () => ({ items: [people[1]] }));
    await expect(new Resolver(api()).resolveUserId("@bo")).rejects.toThrow(
      /No one in this workspace is exactly "bo".*Bob General \(@bob, U0BOBBOB1\).*user ID or exact @handle/
    );
    expect(slack.count("conversations.open")).toBe(0);
  });

  it("accepts an exact handle, display name or real name (case-insensitive)", async () => {
    installSlackStub().on("search.modules", () => ({ items: people }));
    const r = new Resolver(api());
    expect(await r.resolveUserId("@BOB")).toBe("U0BOBBOB1");
    expect(await r.resolveUserId("alice archer")).toBe("U0AAAAAA1");
  });

  it("reports multiple exact matches as ambiguous", async () => {
    installSlackStub().on("search.modules", () => ({
      items: [makeUser("U0SAMSAM1", "sam", "Sam One"), makeUser("U0SAMSAM2", "sam.two", "Sam", { profile: { display_name: "sam" } })],
    }));
    await expect(new Resolver(api()).resolveUserId("@sam")).rejects.toThrow(/matches 2 people exactly.*U0SAMSAM1.*U0SAMSAM2/);
  });

  it("refuses broadcast mentions", async () => {
    const slack = installSlackStub();
    await expect(new Resolver(api()).resolveConversation("@here")).rejects.toThrow(/broadcast mention/);
    expect(slack.count()).toBe(0);
  });

  it("requires email lookups to succeed", async () => {
    installSlackStub().on("users.lookupByEmail", (p) => (p.email === "a@x.dev" ? { user: people[0] } : slackError("users_not_found")));
    const r = new Resolver(api());
    expect(await r.resolveUserId("a@x.dev")).toBe("U0AAAAAA1");
    await expect(r.resolveUserId("nobody@x.dev")).rejects.toThrow(/has the email nobody@x.dev/);
  });

  const many = Array.from({ length: 100 }, (_, i) => makeUser(`U0${String(i).padStart(7, "0")}`, `user${i}`));

  it("falls back to a cached users.list directory for exact matches only", async () => {
    const slack = installSlackStub()
      .fail("search.modules", "unknown_method")
      .on("users.list", (p) => paginate(many, "members", p, 10));
    const r = new Resolver(api());
    expect(await r.resolveUserId("@user25")).toBe("U00000025");
    expect(await r.resolveUserId("@USER2")).toBe("U00000002");
    expect(await r.resolveUserId("user99")).toBe("U00000099");
    await expect(r.resolveUserId("@user")).rejects.toMatchObject({ code: "user_not_found", message: /Close matches/ });
    // One full scan, reused; search.modules isn't retried once it said "unavailable".
    expect(slack.count("users.list")).toBe(10);
    expect(slack.count("search.modules")).toBe(1);
    expect(slack.callsTo("users.list").every((c) => c.params.limit === "200")).toBe(true);
  });

  it("rescans the fallback directory after the TTL and resumes after a failed page", async () => {
    let now = 0;
    let failAt: string | undefined = "20";
    const slack = installSlackStub()
      .fail("search.modules", "missing_scope")
      .on("users.list", (p) => (failAt && p.cursor === failAt ? slackError("ratelimited") : paginate(many, "members", p, 10)));
    const r = new Resolver(api(), { now: () => now, ttlMs: 60_000 });
    await expect(r.resolveUserId("@user5")).rejects.toMatchObject({ code: "ratelimited" });
    failAt = undefined;
    expect(await r.resolveUserId("@user5")).toBe("U00000005");
    expect(slack.callsTo("users.list").map((c) => c.params.cursor ?? "")).toEqual(["", "10", "20", "20", "30", "40", "50", "60", "70", "80", "90"]);
    now += 60_001;
    expect(await r.resolveUserId("@user5")).toBe("U00000005");
    expect(slack.count("users.list")).toBe(21);
  });

  it("never accepts a lone exact match from a truncated users.list directory (R3)", async () => {
    const slack = installSlackStub()
      .fail("search.modules", "unknown_method")
      .on("users.list", (p) => paginate(many, "members", p, 10));
    const r = new Resolver(api(), { maxPages: 3 });
    const err = await r.resolveUserId("@user25").catch((e) => e);
    expect(err).toBeInstanceOf(SlackerError);
    expect(err.code).toBe("directory_too_large");
    expect(err.message).toMatch(/exactly matches user25 \(@user25, U00000025\).*too large to scan fully.*Use the user ID \(find it with `slacker users <name>` \/ find_user\)/);
    await expect(r.resolveUserId("@user99")).rejects.toMatchObject({ code: "directory_too_large" });
    expect(slack.count("users.list")).toBe(3);
  });

  it("never accepts a lone exact match from a full search.modules page (R3)", async () => {
    const page = [makeUser("U0SAMSAM1", "sam", "Sam Exact"), ...many.slice(0, 49)];
    const slack = installSlackStub().on("search.modules", () => ({ items: page }));
    const err = await new Resolver(api()).resolveUserId("@sam").catch((e) => e);
    expect(err).toMatchObject({ code: "ambiguous_user", message: expect.stringMatching(/full page of 50 results.*Use the user ID/) });
    expect(slack.callsTo("search.modules")[0].params.count).toBe("50");
    // 49 results is a complete answer.
    slack.on("search.modules", () => ({ items: page.slice(0, 49) }));
    expect(await new Resolver(api()).resolveUserId("@sam")).toBe("U0SAMSAM1");
  });

  it("surfaces auth errors from people search", async () => {
    installSlackStub().fail("search.modules", "invalid_auth");
    await expect(new Resolver(api()).resolveUserId("@bob")).rejects.toMatchObject({ code: "invalid_auth" });
  });
});

describe("name decoration", () => {
  it("dedupes in-flight users.info and does not cache failures", async () => {
    let fail = true;
    const slack = installSlackStub({ delayMs: 2 }).on("users.info", (p) => (fail ? slackError("ratelimited") : { user: makeUser(p.user, "alice") }));
    const r = new Resolver(api());
    expect(await Promise.all([r.userName("U0AAAAAA1"), r.userName("U0AAAAAA1")])).toEqual(["U0AAAAAA1", "U0AAAAAA1"]);
    expect(slack.count("users.info")).toBe(1);
    fail = false;
    expect(await r.userName("U0AAAAAA1")).toBe("alice");
    expect(await r.userName("U0AAAAAA1")).toBe("alice");
    expect(slack.count("users.info")).toBe(2);
  });

  it("still throws auth failures", async () => {
    installSlackStub().fail("users.info", "invalid_auth");
    await expect(new Resolver(api()).userName("U0AAAAAA1")).rejects.toMatchObject({ code: "invalid_auth" });
  });

  it("caps concurrent lookups at 6", async () => {
    const slack = installSlackStub({ delayMs: 5 }).on("users.info", (p) => ({ user: makeUser(p.user, `n-${p.user}`) }));
    const msgs = Array.from({ length: 40 }, (_, i) => ({ user: `U0${String(i).padStart(7, "0")}`, text: "hi" }));
    const map = await new Resolver(api()).userMap(msgs);
    expect(Object.keys(map)).toHaveLength(40);
    expect(slack.maxInFlight).toBeLessThanOrEqual(6);
    expect(slack.maxInFlight).toBeGreaterThan(1);
  });

  it("collects mentions from blocks when text is empty", async () => {
    installSlackStub().on("users.info", (p) => ({ user: makeUser(p.user, "carol") }));
    const map = await new Resolver(api()).userMap([
      { blocks: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "user", user_id: "U0CAROL01" }] }] }] },
    ] as never);
    expect(map).toEqual({ U0CAROL01: "carol" });
  });

  it("describes DMs as @display (Real Name)", async () => {
    installSlackStub()
      .on("conversations.info", (p) => ({ channel: { id: p.channel, is_im: true, user: "U0BOBBOB1" } }))
      .on("users.info", () => ({ user: makeUser("U0BOBBOB1", "bob", "Bob Smith") }));
    expect(await new Resolver(api()).describeConversation("D0DM12345")).toEqual({
      id: "D0DM12345",
      type: "dm",
      name: "@bob (Bob Smith)",
      userId: "U0BOBBOB1",
    });
  });
});

describe("createLimiter", () => {
  it("never runs more than max tasks at once and propagates results/errors", async () => {
    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    const task = (i: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 2));
        active--;
        if (i === 3) throw new Error("boom");
        return i;
      });
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map(task));
    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled", "rejected", "fulfilled"]);
  });
});
