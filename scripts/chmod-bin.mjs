// Make the CLI entry executable (cross-platform replacement for `chmod +x`; a no-op on Windows).
import { chmodSync } from "node:fs";

chmodSync(new URL("../dist/index.js", import.meta.url), 0o755);
