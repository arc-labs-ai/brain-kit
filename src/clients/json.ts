/**
 * The shared read-merge-write JSON config writer.
 *
 * Four of the five clients keep their MCP servers in a JSON file, and each one
 * of those files belongs to the user, not to us: it holds their other servers,
 * their editor preferences, whatever that app decided to put there. So every
 * write is a merge, and the rules below exist because each has a way to lose
 * someone's configuration.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** An MCP server entry, as every one of these files spells it. */
export type ServerEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** What a write did. */
export type WriteResult = {
  /** Where it was written. */
  path: string;
  /** Whether an existing entry of the same name was replaced. */
  replaced: boolean;
  /** The backup, when one was taken. */
  backup: string | undefined;
};

export class WriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteError";
  }
}

/**
 * Merge `entry` into the `mcpServers` map of the JSON file at `path`.
 *
 * - **An unparseable file is refused, not replaced.** A trailing comma in
 *   someone's config is not permission to delete the rest of it. They get a
 *   message naming the file and the snippet to paste.
 * - **A backup is taken before the first change**, so there is always a way
 *   back from a merge that went wrong.
 * - **The write is atomic** — temp file then rename — so an interrupted write
 *   cannot leave a half-serialised config that the client then refuses to
 *   load.
 * - **The file ends up `0600`.** It now contains an API key. The clients
 *   themselves are inconsistent about this, and a credential in a
 *   world-readable file in a home directory is worth one `chmod`.
 */
export function mergeServer(path: string, name: string, entry: ServerEntry): WriteResult {
  const existing = readConfig(path);
  const servers = asRecord(existing.mcpServers) ?? {};
  const replaced = Object.hasOwn(servers, name);

  const backup = existsSync(path) ? backupOnce(path) : undefined;

  const next = {
    ...existing,
    mcpServers: { ...servers, [name]: entry },
  };
  writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  return { path, replaced, backup };
}

/** Remove `name` from the file's `mcpServers`, if it is there. */
export function removeServer(path: string, name: string): boolean {
  if (!existsSync(path)) return false;
  const existing = readConfig(path);
  const servers = asRecord(existing.mcpServers);
  if (!servers || !Object.hasOwn(servers, name)) return false;
  backupOnce(path);
  const { [name]: _removed, ...rest } = servers;
  writeAtomic(path, `${JSON.stringify({ ...existing, mcpServers: rest }, null, 2)}\n`);
  return true;
}

/** The server entry named `name`, if the file has one. */
export function readServer(path: string, name: string): ServerEntry | undefined {
  if (!existsSync(path)) return undefined;
  let servers: Record<string, unknown> | undefined;
  try {
    servers = asRecord(readConfig(path).mcpServers);
  } catch {
    // A config we cannot parse is a config we cannot report on. Not an error
    // here: the caller is inspecting, not writing.
    return undefined;
  }
  const entry = servers?.[name];
  return isServerEntry(entry) ? entry : undefined;
}

/** Parse the file, or `{}` for one that does not exist yet. */
function readConfig(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  // An empty or whitespace-only file is a normal state for a config an app
  // created but never wrote to; `JSON.parse("")` throws, which would read as
  // corruption.
  if (raw.trim() === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    const record = asRecord(parsed);
    if (!record) {
      throw new WriteError(
        `${path} does not contain a JSON object. Leaving it alone — add the server by hand.`,
      );
    }
    return record;
  } catch (err) {
    if (err instanceof WriteError) throw err;
    throw new WriteError(
      `${path} is not valid JSON, so it was left untouched rather than overwritten. Fix the file, or add the server by hand.`,
    );
  }
}

/**
 * Copy `path` aside once, keeping the first backup.
 *
 * The FIRST, not the latest: the useful backup is the one from before this
 * tool ever touched the file. Overwriting it on a second run would replace
 * the user's original with our own earlier output — which is exactly when
 * someone reaches for a backup.
 */
function backupOnce(path: string): string {
  const backup = `${path}.brain-backup`;
  if (!existsSync(backup)) copyFileSync(path, backup);
  return backup;
}

/** Write via a temp file and rename, then lock the permissions down. */
function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${basename(path)}.brain-tmp`);
  writeFileSync(temp, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // A filesystem that does not do POSIX modes. The content is still right.
  }
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isServerEntry(value: unknown): value is ServerEntry {
  const record = asRecord(value);
  return !!record && typeof record.command === "string" && Array.isArray(record.args);
}
