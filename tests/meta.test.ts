import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { nodeVersionProblem, supportedNode } from "../src/node-check.js";
import { VERSION } from "../src/version.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");

describe("versions (D9)", () => {
  it("package.json and the Claude Code plugin manifest carry the same version (bump both)", () => {
    const pkg = JSON.parse(read("package.json")).version;
    const plugin = JSON.parse(read("plugin/.claude-plugin/plugin.json")).version;
    expect(plugin).toBe(pkg);
    expect(VERSION).toBe(pkg);
  });
});

describe("Node version check (A-P2-12)", () => {
  it.each([
    ["22.12.0", true],
    ["v22.12.1", true],
    ["23.0.0", true],
    ["24.18.0", true],
    ["22.11.9", false],
    ["20.18.0", false],
    ["18.0.0", false],
  ])("Node %s supported: %s", (version, ok) => {
    expect(supportedNode(version)).toBe(ok);
    expect(nodeVersionProblem(version, "/usr/bin/node") === undefined).toBe(ok);
  });

  it("explains what to do on an old Node", () => {
    expect(nodeVersionProblem("20.18.0", "/usr/bin/node")).toBe(
      "slacker needs Node.js 22.12 or newer, but this is Node 20.18.0 (/usr/bin/node). Install a newer Node (https://nodejs.org, or your package manager) and run slacker with it."
    );
  });

  it("the entry point checks before loading anything else (its only static import is the import-free check)", () => {
    const entry = read("src/index.ts");
    expect(entry.match(/^import .*$/gm)).toEqual([`import { nodeVersionProblem } from "./node-check.js";`]);
    expect(read("src/node-check.ts")).not.toMatch(/^import /m);
    expect(entry.indexOf("nodeVersionProblem()")).toBeLessThan(entry.indexOf('import("./cli.js")'));
    expect(entry).toMatch(/process\.exit\(1\)/);
  });
});
