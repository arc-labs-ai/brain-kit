#!/usr/bin/env node
/**
 * The executable.
 *
 * Separate from `index.ts`, which is the barrel. An entrypoint that is also a
 * barrel means importing the package runs a command — so the two are different
 * files, and this one holds the only top-level side effect in the package.
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli.js";

/**
 * Whether this module is the program being run, as opposed to being imported.
 *
 * ## The bug this shape exists to avoid
 *
 * The obvious spelling is:
 *
 * ```ts
 * if (import.meta.url === `file://${process.argv[1]}`) main();
 * ```
 *
 * It is wrong, and it shipped. **npm installs a package's `bin` as a
 * symlink**, so `process.argv[1]` is the link in `node_modules/.bin` while
 * `import.meta.url` is the real file it points at. The two strings never
 * match. The published package therefore started, compared, matched nothing,
 * ran no program, and exited **0** — and because the exit code was zero, every
 * surface that reported on it reported success. An MCP client just said the
 * connection closed.
 *
 * `realpathSync` on both sides resolves the symlink, and `fileURLToPath`
 * handles the percent-encoding that the string form gets wrong for any path
 * containing a space or a non-ASCII character.
 */
function isEntrypoint(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // A path that cannot be resolved is not this file.
    return false;
  }
}

/** This package's version, read from the manifest beside the build. */
function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = readFileSync(join(here, "..", "package.json"), "utf8");
    return (JSON.parse(manifest) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2), version())
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `\n  ✗ ${err instanceof Error ? err.message : String(err)}\n\n`,
      );
      process.exitCode = 1;
    });
}

export { main, isEntrypoint };
