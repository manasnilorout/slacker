/**
 * The Node version check, kept free of imports so the entry point can run it before loading the
 * rest of slacker (which fails in obscure ways on older Node, e.g. AbortSignal.any).
 */

/** slacker needs Node ≥ 22.12. `version` is "22.12.0" or "v22.12.0". */
export function supportedNode(version: string): boolean {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

/** Why this Node can't run slacker (the message the CLI prints), or undefined when it can. */
export function nodeVersionProblem(version: string = process.versions.node, execPath: string = process.execPath): string | undefined {
  if (supportedNode(version)) return undefined;
  return (
    `slacker needs Node.js 22.12 or newer, but this is Node ${version.replace(/^v/, "")} (${execPath}). ` +
    "Install a newer Node (https://nodejs.org, or your package manager) and run slacker with it."
  );
}
