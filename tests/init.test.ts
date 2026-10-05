import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// init finds "the slacker on PATH" by comparing it with this install's entry; point that at a temp file.
const fake = vi.hoisted(() => ({ entry: "" }));
vi.mock("../src/command.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/command.js")>()),
  entryPath: () => fake.entry,
}));

import { initProject, InitOpts } from "../src/init.js";
import { installSlackStub, restoreAll, TempConfig, writeTempConfig } from "./helpers/slackStub.js";

const savedPath = process.env.PATH;
const savedWorkspace = process.env.SLACKER_WORKSPACE;
let root: string;
let cfg: TempConfig;
let cwd: string;
let bin: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "slacker-init-"));
  mkdirSync(join(root, "slacker", "dist"), { recursive: true });
  fake.entry = join(root, "slacker", "dist", "index.js");
  writeFileSync(fake.entry, "#!/usr/bin/env node\n");
  bin = join(root, "bin");
  mkdirSync(bin);
  symlinkSync(fake.entry, join(bin, "slacker")); // what npm link creates
  cwd = join(root, "project");
  mkdirSync(cwd);
  cfg = writeTempConfig();
  delete process.env.SLACKER_WORKSPACE;
});

afterEach(() => {
  restoreAll();
  cfg.cleanup();
  rmSync(root, { recursive: true, force: true });
  process.env.PATH = savedPath;
  if (savedWorkspace === undefined) delete process.env.SLACKER_WORKSPACE;
  else process.env.SLACKER_WORKSPACE = savedWorkspace;
});

const init = (o: InitOpts) => initProject(["work"], o, { configFile: cfg.file, cwd, execPath: process.execPath, nodeCandidates: [] });

describe("init with slacker on PATH (F3)", () => {
  it("writes the absolute path of that slacker, not a bare name GUI clients can't find", async () => {
    installSlackStub();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const r = await init({ mcp: true });
    const command = join(bin, "slacker");
    expect(r.servers[0]).toMatchObject({ command, args: ["serve", "--workspace", "work", "--config", cfg.file] });
    expect(JSON.parse(readFileSync(join(cwd, ".mcp.json"), "utf-8")).mcpServers.slacker.command).toBe(command);
    expect(r.claudeMcpAdd[0]).toContain(`-- ${command} serve --workspace work`);
  });

  it("a rerun still recognises the entry as slacker's (no --replace needed)", async () => {
    installSlackStub();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    await init({ mcp: true });
    const again = await init({ mcp: true });
    expect(again.servers[0].replaced).toBe(true);
    expect(again.overridden).toEqual([]);
  });

  it("--command slacker is kept as given", async () => {
    installSlackStub();
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    expect((await init({ mcp: true, command: "slacker" })).servers[0].command).toBe("slacker");
  });

  it("without slacker on PATH: node + entry", async () => {
    installSlackStub();
    process.env.PATH = "/usr/bin:/bin";
    expect((await init({ mcp: true })).servers[0]).toMatchObject({ command: process.execPath, args: [fake.entry, "serve", "--workspace", "work", "--config", cfg.file] });
  });
});
