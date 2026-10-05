import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chooseWorkspace, findProjectSettings } from "../src/config.js";

const temp = realpathSync(mkdtempSync(join(tmpdir(), "slacker-proj-")));
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const saved = { ...process.env };
beforeEach(() => {
  delete process.env.SLACKER_WORKSPACE;
  delete process.env.SLACKER_READ_ONLY;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("chooseWorkspace", () => {
  const root = join(temp, "project");
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(root, ".slacker.json"), JSON.stringify({ workspace: "work", readOnly: true }));
  const outside = join(temp, "outside");
  mkdirSync(outside);

  it("finds .slacker.json in a parent directory", () => {
    expect(findProjectSettings(nested)?.settings).toEqual({ workspace: "work", readOnly: true });
  });
  it("uses the project file when nothing else is set", () => {
    expect(chooseWorkspace(undefined, nested)).toMatchObject({ name: "work", source: "project", readOnly: true });
  });
  it("env beats the project file", () => {
    process.env.SLACKER_WORKSPACE = "side";
    expect(chooseWorkspace(undefined, nested)).toMatchObject({ name: "side", source: "env" });
  });
  it("flag beats everything", () => {
    process.env.SLACKER_WORKSPACE = "side";
    expect(chooseWorkspace("other", nested)).toMatchObject({ name: "other", source: "flag" });
  });
  it("trims the flag and env names", () => {
    expect(chooseWorkspace(" other ", nested)).toMatchObject({ name: "other", source: "flag" });
    process.env.SLACKER_WORKSPACE = "  side\t";
    expect(chooseWorkspace("   ", nested)).toMatchObject({ name: "side", source: "env" });
  });
  it("trims the project file's workspace", () => {
    const dir = join(temp, "padded");
    mkdirSync(dir);
    writeFileSync(join(dir, ".slacker.json"), JSON.stringify({ workspace: " work " }));
    expect(chooseWorkspace(undefined, dir)).toMatchObject({ name: "work", source: "project" });
  });
  it("falls back to the config default outside a project", () => {
    expect(chooseWorkspace(undefined, outside)).toMatchObject({ source: "default", readOnly: false });
  });

  it.each(["1", "true", "TRUE", "yes", "On", "anything"])("SLACKER_READ_ONLY=%s is read-only", (v) => {
    process.env.SLACKER_READ_ONLY = v;
    expect(chooseWorkspace(undefined, outside).readOnly).toBe(true);
  });
  it.each(["", "0", "false", "no", "OFF"])("SLACKER_READ_ONLY=%s is writable", (v) => {
    process.env.SLACKER_READ_ONLY = v;
    expect(chooseWorkspace(undefined, outside).readOnly).toBe(false);
  });
  it("env can't turn off a project's readOnly", () => {
    process.env.SLACKER_READ_ONLY = "0";
    expect(chooseWorkspace(undefined, nested).readOnly).toBe(true);
  });
});

describe(".slacker.json validation", () => {
  let n = 0;
  function project(content: string): string {
    const dir = join(temp, `v${++n}`);
    mkdirSync(dir);
    writeFileSync(join(dir, ".slacker.json"), content);
    return dir;
  }

  it.each([
    ["null", "null", /expected object/],
    ["array", "[]", /expected object/],
    ["string", '"work"', /expected object/],
    ["non-string workspace", '{"workspace": 5}', /"workspace"/],
    ["empty workspace", '{"workspace": "  "}', /non-empty/],
    ["non-boolean readOnly", '{"readOnly": "yes"}', /"readOnly" must be true or false/],
    ["corrupt JSON", "{oops", /Could not parse/],
  ])("rejects %s, naming the file", (_label, content, pattern) => {
    const dir = project(content);
    const file = join(dir, ".slacker.json");
    expect(() => findProjectSettings(dir)).toThrow(pattern);
    expect(() => chooseWorkspace(undefined, dir)).toThrow(file);
  });

  it("ignores unknown keys", () => {
    const dir = project('{"workspace": "work", "future": 1}');
    expect(findProjectSettings(dir)?.settings).toEqual({ workspace: "work" });
  });
});

describe("symlinked working directory", () => {
  // temp/repos/.slacker.json, and temp/repos/code → temp/elsewhere/code (a symlink).
  const repos = join(temp, "repos");
  const physical = join(temp, "elsewhere", "code");
  const logical = join(repos, "code");
  mkdirSync(repos);
  mkdirSync(physical, { recursive: true });
  symlinkSync(physical, logical);
  writeFileSync(join(repos, ".slacker.json"), JSON.stringify({ workspace: "work", readOnly: true }));

  it("finds .slacker.json above the logical $PWD", () => {
    process.env.PWD = logical;
    expect(chooseWorkspace(undefined, physical)).toMatchObject({ name: "work", readOnly: true, projectFile: join(repos, ".slacker.json") });
  });

  it("ignores a $PWD that is a different directory", () => {
    process.env.PWD = repos;
    expect(chooseWorkspace(undefined, physical)).toMatchObject({ source: "default", readOnly: false });
  });
});
