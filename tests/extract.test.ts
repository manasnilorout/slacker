import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import { createCipheriv, pbkdf2Sync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// A fake home with a fake Slack desktop profile; `security`/`sqlite3`/`secret-tool` are stubbed.
const state = vi.hoisted(() => ({
  home: "",
  platform: "darwin" as string,
  exec: {} as Record<string, () => string>,
  timeouts: {} as Record<string, number | undefined>,
}));

vi.mock("node:os", async (orig) => {
  const os = await orig<typeof import("node:os")>();
  return { ...os, homedir: () => state.home, platform: () => state.platform };
});
vi.mock("node:child_process", () => ({
  execFileSync: (cmd: string, _args: string[], opts?: { timeout?: number }) => {
    state.timeouts[cmd] = opts?.timeout;
    const fn = state.exec[cmd];
    if (!fn) throw Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: "ENOENT" });
    return fn();
  },
}));

const { extractTokensFromSlack } = await import("../src/config.js");

const tmp = mkdtempSync(join((await vi.importActual<typeof import("node:os")>("node:os")).tmpdir(), "slacker-extract-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function encrypt(prefix: string, password: string, iterations: number, value: string): string {
  const key = pbkdf2Sync(password, "saltysalt", iterations, 16, "sha1");
  const c = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  return Buffer.concat([Buffer.from(prefix), c.update(Buffer.alloc(32, 1)), c.update(value), c.final()]).toString("hex");
}

const fail = (status: number, stderr: string) => () => {
  throw Object.assign(new Error("Command failed"), { status, stderr });
};

let n = 0;
beforeEach(() => {
  state.home = join(tmp, `h${++n}`);
  state.platform = "darwin";
  state.exec = {};
  state.timeouts = {};
  for (const slack of [join(state.home, "Library", "Application Support", "Slack"), join(state.home, ".config", "Slack")]) {
    mkdirSync(join(slack, "Local Storage", "leveldb"), { recursive: true });
    writeFileSync(join(slack, "Local Storage", "leveldb", "000.log"), "junk xoxc-123-456-abc junk");
    writeFileSync(join(slack, "Cookies"), "");
  }
});

describe("extractTokensFromSlack on macOS", () => {
  it("decrypts with the Keychain password", () => {
    state.exec.security = () => "s3cret\n";
    state.exec.sqlite3 = () => encrypt("v10", "s3cret", 1003, "xoxd-abc%2Fdef");
    expect(extractTokensFromSlack()).toEqual({ tokens: ["xoxc-123-456-abc"], cookie: "xoxd-abc%2Fdef" });
  });

  it("gives the Keychain prompt 120s but other tools 15s", () => {
    state.exec.security = () => "s3cret\n";
    state.exec.sqlite3 = () => encrypt("v10", "s3cret", 1003, "xoxd-abc");
    extractTokensFromSlack();
    expect(state.timeouts).toEqual({ sqlite3: 15_000, security: 120_000 });
  });

  it("explains a Keychain timeout", () => {
    state.exec.security = () => {
      throw Object.assign(new Error("spawnSync security ETIMEDOUT"), { code: "ETIMEDOUT" });
    };
    state.exec.sqlite3 = () => encrypt("v10", "s3cret", 1003, "xoxd-abc");
    expect(extractTokensFromSlack().cookieError).toMatch(/timed out — the Keychain prompt may be hidden/);
  });

  it("gives a clear error when Keychain access is denied (no silent fallback)", () => {
    state.exec.security = fail(51, "security: SecKeychainSearchCopyNext: User interaction is not allowed.");
    state.exec.sqlite3 = () => encrypt("v10", "s3cret", 1003, "xoxd-abc");
    const r = extractTokensFromSlack();
    expect(r.cookie).toBeNull();
    expect(r.cookieError).toMatch(/Could not read "Slack Safe Storage" from the macOS Keychain.*Always Allow.*auth add/);
  });

  it("falls back to the default key only when the Keychain item doesn't exist", () => {
    state.exec.security = fail(44, "The specified item could not be found in the keychain.");
    state.exec.sqlite3 = () => encrypt("v10", "peanuts", 1, "xoxd-peanut");
    expect(extractTokensFromSlack().cookie).toBe("xoxd-peanut");
  });

  it("says the item was missing when the default key doesn't decrypt", () => {
    state.exec.security = fail(44, "The specified item could not be found in the keychain.");
    state.exec.sqlite3 = () => encrypt("v10", "other", 1003, "xoxd-x");
    expect(extractTokensFromSlack().cookieError).toMatch(/default key \(no "Slack Safe Storage" item in the Keychain\)/);
  });

  it("explains a missing sqlite3", () => {
    state.exec.security = () => "s3cret";
    expect(extractTokensFromSlack().cookieError).toMatch(/sqlite3 is required/);
  });
});

describe("extractTokensFromSlack on Linux", () => {
  beforeEach(() => {
    state.platform = "linux";
  });

  it("uses the peanuts key for v10 even when the keyring has a password", () => {
    state.exec["secret-tool"] = () => "keyringpw";
    state.exec.sqlite3 = () => encrypt("v10", "peanuts", 1, "xoxd-v10");
    expect(extractTokensFromSlack().cookie).toBe("xoxd-v10");
  });

  it("uses the keyring password for v11", () => {
    state.exec["secret-tool"] = () => "keyringpw";
    state.exec.sqlite3 = () => encrypt("v11", "keyringpw", 1, "xoxd-v11");
    expect(extractTokensFromSlack().cookie).toBe("xoxd-v11");
  });

  it("explains a v11 cookie without secret-tool", () => {
    state.exec.sqlite3 = () => encrypt("v11", "keyringpw", 1, "xoxd-v11");
    expect(extractTokensFromSlack().cookieError).toMatch(/secret-tool/);
  });
});

describe("extractTokensFromSlack on Windows", () => {
  it("refuses with a pointer to auth add", () => {
    state.platform = "win32";
    expect(() => extractTokensFromSlack()).toThrow(/isn't supported on Windows.*auth add/);
  });
});
