/**
 * A user-facing failure with a stable machine-readable `code` (shown in CLI `--json` errors and
 * usable by MCP clients). `message` is always self-contained; `hint`, when present, repeats the
 * main next step on its own for callers that display it separately.
 */
export class SlackerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly hint?: string
  ) {
    super(message);
    this.name = "SlackerError";
  }
}
