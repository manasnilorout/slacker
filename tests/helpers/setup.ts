/**
 * Runs before every test file. Nothing a test does may touch the real machine's slacker state:
 * - HOME is a fresh temp dir (so ~/.config/slack-cli/config.json and ~/.config/slacker are fake),
 * - SLACKER_CONFIG points at a config file that doesn't exist there,
 * - SLACKER_TRUST_FILE (`slacker trust`, `slacker init`) goes to a temp file,
 * - PWD is a temp dir, so no .slacker.json above a logical $PWD can leak into a test,
 * - the umask is 022, so files the tests create aren't group-writable (that would make a .slacker.json
 *   or trust file "foreign") whatever the machine's umask is.
 * Tests that need a fresh store per test set these themselves.
 */
import { afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "slacker-test-env-"));
const home = join(dir, "home");
const pwd = join(dir, "pwd");
mkdirSync(home);
mkdirSync(pwd);
process.env.HOME = home;
process.env.SLACKER_CONFIG = join(home, "no-config.json");
process.env.SLACKER_TRUST_FILE = join(dir, "trusted-projects.json");
process.env.PWD = pwd;
try {
  process.umask(0o022);
} catch {
  // not allowed in worker threads; the forks pool (default) allows it
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));
