/** A non-null, non-array object (what JSON.parse gives for `{…}`). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The message of an Error, or the stringified value for anything else that was thrown. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `["a", "b"]` → `"a", "b"` for messages that list workspace names. */
export function quoteNames(names: string[]): string {
  return names.map((n) => `"${n}"`).join(", ");
}

/** zod issues as one line: `"readOnly" must be true or false; "workspace" must be …`. */
export function formatIssues(issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>): string {
  return issues.map((i) => (i.path.length ? `"${i.path.map(String).join(".")}" ${i.message}` : i.message)).join("; ");
}
