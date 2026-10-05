// Remove dist/ before a build so stale files (old modules, source maps) never get packed.
import { rmSync } from "node:fs";

rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });
