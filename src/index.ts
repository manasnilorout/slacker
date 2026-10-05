#!/usr/bin/env node
// Only node-check.js is imported statically (it has no imports): everything else is loaded after the
// Node version check, so an old Node gets a clear message instead of a crash deep inside slacker.
import { nodeVersionProblem } from "./node-check.js";

const problem = nodeVersionProblem();
if (problem) {
  const args = process.argv.slice(2);
  const end = args.indexOf("--");
  if ((end < 0 ? args : args.slice(0, end)).includes("--json")) {
    process.stdout.write(`${JSON.stringify({ error: { message: problem, code: "unsupported_node" } }, null, 2)}\n`);
  } else {
    process.stderr.write(`${problem}\n`);
  }
  process.exit(1);
} else {
  void import("./cli.js").then(({ main }) => main());
}
