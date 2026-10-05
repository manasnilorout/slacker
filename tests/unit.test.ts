import { afterAll, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSlackLink } from "../src/resolve.js";
import { resolveMentions, tsToIso } from "../src/format.js";
import { resolveWorkspace } from "../src/config.js";

describe("parseSlackLink", () => {
  it("parses a message link", () => {
    expect(parseSlackLink("https://acme.slack.com/archives/C0123ABCD/p1700000000123456")).toEqual({
      host: "acme.slack.com",
      channel: "C0123ABCD",
      ts: "1700000000.123456",
      threadTs: undefined,
    });
  });
  it("parses a thread reply link", () => {
    const link = "https://acme.slack.com/archives/C0123ABCD/p1700000099000001?thread_ts=1700000000.123456&cid=C0123ABCD";
    expect(parseSlackLink(link)).toMatchObject({ ts: "1700000099.000001", threadTs: "1700000000.123456" });
  });
  it("returns null for non-links", () => {
    expect(parseSlackLink("#general")).toBeNull();
  });
});

describe("resolveMentions", () => {
  it("renders users, channels, links and specials", () => {
    const text = "hi <@U123> and <@U999|bob> in <#C1|eng> see <https://x.dev|docs> <!here> &amp; <https://y.dev>";
    expect(resolveMentions(text, { U123: "alice" })).toBe("hi @alice and @bob in #eng see docs (https://x.dev) @here & https://y.dev");
  });
});

describe("tsToIso", () => {
  it("converts slack ts", () => {
    expect(tsToIso("1700000000.123456")).toBe("2023-11-14T22:13:20.123Z");
  });
});

describe("resolveWorkspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "slacker-"));
  const file = join(dir, "config.json");
  const ws = (team: string) => ({ token: "xoxc-1", cookie: "xoxd-1", url: `https://${team}.slack.com/`, userId: "U1", teamId: team });
  writeFileSync(file, JSON.stringify({ workspaces: { work: ws("T1"), side: ws("T2") }, defaultWorkspace: "work" }));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("picks the named workspace", () => {
    expect(resolveWorkspace("side", file)).toMatchObject({ name: "side", teamId: "T2" });
  });
  it("falls back to default", () => {
    expect(resolveWorkspace(undefined, file)).toMatchObject({ name: "work" });
  });
  it("lists available workspaces on a miss", () => {
    expect(() => resolveWorkspace("nope", file)).toThrow(/Available: work, side/);
  });
});
