import { describe, it, expect } from "vitest";
import { tsToIso, resolveMentions, formatMessage, blocksText, rawMessageText } from "../src/format.js";

describe("tsToIso", () => {
  it("converts Slack ts and numbers", () => {
    expect(tsToIso("1700000000.123456")).toBe("2023-11-14T22:13:20.123Z");
    expect(tsToIso(1700000000)).toBe("2023-11-14T22:13:20.000Z");
  });
  it("returns null instead of throwing for junk or out-of-range values", () => {
    for (const v of ["abc", "99999999999999999", "", undefined, null, "Infinity"]) expect(tsToIso(v as never), String(v)).toBeNull();
  });
});

describe("resolveMentions", () => {
  const users = { U1: "alice", U2: "<b>" };
  it.each([
    ["hi <@U1> and <@U9|bob> <@U8>", "hi @alice and @bob @U8"],
    ["<#C1|eng> <#C2>", "#eng #C2"],
    ["<!subteam^S1|@devs> <!subteam^S1>", "@devs @group"],
    ["<!here|here> <!channel> <!everyone>", "@here @channel @everyone"],
    ["see <https://x.dev|docs> <https://y.dev>", "see docs (https://x.dev) https://y.dev"],
    ["<mailto:a@b.co|a@b.co>", "a@b.co"],
    ["<!date^1392734382^{date} at {time}|Feb 18, 2014 at 6:39 AM>", "Feb 18, 2014 at 6:39 AM"],
    ["<!date^1392734382^{date}>", "2014-02-18T14:39:42.000Z"],
    ["<slack://channel?id=C1&team=T1|open channel>", "open channel"],
    ["<tel:+15551234|call me> <tel:+15550000>", "call me +15550000"],
    ["&amp;lt;b&amp;gt; literal &lt;ok&gt;", "&lt;b&gt; literal <ok>"],
  ])("%s", (input, expected) => {
    expect(resolveMentions(input, users)).toBe(expected);
  });
});

describe("blocks and attachments", () => {
  const richBlocks = [
    {
      type: "rich_text",
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Deploy by " },
            { type: "user", user_id: "U1" },
            { type: "text", text: " in " },
            { type: "channel", channel_id: "C1" },
            { type: "text", text: " " },
            { type: "emoji", name: "rocket" },
            { type: "text", text: " " },
            { type: "broadcast", range: "here" },
            { type: "text", text: " " },
            { type: "link", url: "https://x.dev", text: "notes" },
          ],
        },
        {
          type: "rich_text_list",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "one" }] },
            { type: "rich_text_section", elements: [{ type: "text", text: "two" }] },
          ],
        },
      ],
    },
    { type: "section", text: { type: "mrkdwn", text: "*Status*" }, fields: [{ type: "mrkdwn", text: "ok" }] },
    { type: "context", elements: [{ type: "mrkdwn", text: "via bot" }, { type: "image", alt_text: "x" }] },
    { type: "divider" },
  ];

  it("extracts rich_text, section and context text", () => {
    expect(blocksText(richBlocks)).toBe(
      "Deploy by <@U1> in <#C1> :rocket: @here notes (https://x.dev)\n• one\n• two\n*Status*\nok\nvia bot"
    );
  });

  it("formatMessage falls back to blocks, then attachments, when text is empty", () => {
    const fromBlocks = formatMessage({ ts: "1700000000.000001", user: "U1", text: "", blocks: richBlocks }, { U1: "alice" });
    expect(fromBlocks.text).toMatch(/^Deploy by @alice in #C1 :rocket:/);

    const fromAttachment = formatMessage(
      { ts: "1700000000.000001", bot_id: "B1", attachments: [{ pretext: "Alert", title: "CPU high", text: "92% on <@U1>" }] },
      { U1: "alice" }
    );
    expect(fromAttachment.text).toBe("Alert\nCPU high\n92% on @alice");
    expect(rawMessageText({ attachments: [{ fallback: "fb", title: "ignored" }] })).toBe("fb");
  });

  it("keeps text when present", () => {
    expect(formatMessage({ ts: "1.1", user: "U1", text: "hello", blocks: richBlocks }, {}).text).toBe("hello");
  });
});

describe("formatMessage authors", () => {
  it("names bots by bot_profile, username, then bot_id", () => {
    expect(formatMessage({ ts: "1.1", bot_id: "B1", bot_profile: { name: "Deploybot" }, username: "x" }, {}).user).toBe("Deploybot");
    expect(formatMessage({ ts: "1.1", bot_id: "B1", username: "hook" }, {}).user).toBe("hook");
    expect(formatMessage({ ts: "1.1", bot_id: "B1", text: "x" }, {})).toMatchObject({ user: "B1", botId: "B1" });
    expect(formatMessage({ ts: "1.1" }, {}).user).toBe("unknown");
  });

  it("handles files without names and keeps optional fields compact", () => {
    const out = formatMessage({ ts: "1.1", user: "U1", files: [{ mode: "tombstone" }], reply_count: 2, thread_ts: "1.1" }, {});
    expect(out).toMatchObject({ files: [{ name: "(deleted file)" }], replyCount: 2, threadTs: "1.1", user: "U1" });
    expect(out).not.toHaveProperty("reactions");
  });
});
