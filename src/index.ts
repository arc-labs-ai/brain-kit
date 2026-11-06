/**
 * The package's library surface.
 *
 * This is a CLI first — `bin.ts` is what `npx @brain-db/cli` runs — but the
 * pieces are useful on their own, and keeping one barrel at the root means
 * there is exactly one answer to "what does this package expose".
 *
 * Exports only. The executable lives in `bin.ts` so that importing this file
 * cannot have the side effect of running a command, which is what happens when
 * an entrypoint and a barrel are the same file.
 */

export * from "./clients/index.js";
export * from "./commands/index.js";
export * from "./connect/index.js";
export { main, parse, type Parsed, USAGE, UsageError } from "./cli.js";
