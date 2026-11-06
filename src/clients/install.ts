/**
 * Detecting and configuring each client.
 */

import { existsSync } from "node:fs";
import { WriteError, mergeServer, readServer } from "./json.js";
import { available, jsonFrom, looksUnsupported, reasonFrom, run } from "./run.js";
import type { ClientTarget, ServerSpec } from "./targets.js";

/** The npm spec written into every client config. */
export const SERVER_PACKAGE = "@brain-db/mcp";

/** The Claude Code marketplace and plugin this installs. */
export const MARKETPLACE = "arc-labs";
export const MARKETPLACE_SOURCE = "arc-labs-ai/brain-kit";
export const PLUGIN = "brain";

export type Outcome = {
  client: ClientTarget;
  status: "configured" | "skipped" | "failed";
  /** One line, written for a terminal. */
  detail: string;
};

/** Whether this machine appears to have `target` installed. */
export function detect(target: ClientTarget): boolean {
  if (target.evidence.some((p) => existsSync(p))) return true;
  // A CLI can be installed with no config directory yet — a fresh `codex`
  // that has never been run. Its binary is the better evidence.
  const writer = target.writer;
  if (writer.kind === "cli" || writer.kind === "plugin") {
    return available(writer.bin);
  }
  return false;
}

/** Configure `target` for `spec`. */
export function install(
  target: ClientTarget,
  spec: ServerSpec,
  dryRun: boolean,
): Outcome {
  const writer = target.writer;
  if (dryRun) {
    const where =
      writer.kind === "json"
        ? writer.path
        : writer.kind === "plugin"
          ? `plugin ${PLUGIN}@${MARKETPLACE}`
          : `\`${writer.bin} mcp add\``;
    return { client: target, status: "skipped", detail: `would configure ${where}` };
  }
  switch (writer.kind) {
    case "json":
      return viaJson(target, writer.path, spec);
    case "cli":
      return viaCli(target, writer.bin, spec);
    case "plugin":
      return viaPlugin(target, writer.bin, spec);
  }
}

/** Merge the server into a JSON config. */
function viaJson(target: ClientTarget, path: string, spec: ServerSpec): Outcome {
  try {
    const result = mergeServer(path, spec.name, {
      command: spec.command,
      args: spec.args,
      env: spec.env,
    });
    return {
      client: target,
      status: "configured",
      detail: `${result.replaced ? "updated" : "added"} ${result.path}`,
    };
  } catch (err) {
    return {
      client: target,
      status: "failed",
      detail: err instanceof WriteError ? err.message : String(err),
    };
  }
}

/** Let the client's own CLI write its config. */
function viaCli(target: ClientTarget, bin: string, spec: ServerSpec): Outcome {
  // Replace rather than stack: `mcp add` on an existing name is an error in
  // some versions and a duplicate in others, and the correct end state is one
  // entry pointing at the current package either way. The remove is allowed
  // to fail — it usually does, because there was nothing there.
  run(bin, ["mcp", "remove", spec.name], { timeoutMs: 20_000 });

  const args = ["mcp", "add", spec.name];
  for (const [key, value] of Object.entries(spec.env)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push("--", spec.command, ...spec.args);

  const result = run(bin, args);
  if (result.missing) {
    return {
      client: target,
      status: "failed",
      detail: `\`${bin}\` is not on PATH. Install it, or skip this client with --client.`,
    };
  }
  if (result.code !== 0) {
    return {
      client: target,
      status: "failed",
      detail: looksUnsupported(result)
        ? `this version of \`${bin}\` does not support \`mcp add\` — update it, then run connect again`
        : reasonFrom(result),
    };
  }
  return { client: target, status: "configured", detail: `via \`${bin} mcp add\`` };
}

/**
 * Install the Claude Code plugin, which carries the MCP server AND the skill,
 * and put the credential in the OS keychain.
 *
 * Three steps, and each one has a reason it is not simpler:
 *
 * 1. **Remove our own shadowing server first.** A user-scoped MCP server
 *    shadows a plugin's server of the same name, so an older install of
 *    `@brain-db/mcp init` leaves the plugin healthy-looking and inert. Only a
 *    server that matches OUR signature is removed — a `brain` server someone
 *    else wrote is theirs, and is reported rather than deleted.
 * 2. **Point the marketplace at the right source.** If one is already
 *    registered under this name from somewhere else, it is replaced; adding
 *    over an existing name is an error, and leaving a stale source installs a
 *    stale plugin.
 * 3. **`--config` for the credential**, which stores a `sensitive` value the
 *    way the interactive flow does: in the keychain, not in a file.
 */
function viaPlugin(target: ClientTarget, bin: string, spec: ServerSpec): Outcome {
  if (!available(bin)) {
    return {
      client: target,
      status: "failed",
      detail: `\`${bin}\` is not on PATH. Install Claude Code, or skip it with --client.`,
    };
  }

  const shadow = clearShadowingServer(bin, spec.name);
  if (shadow === "foreign") {
    return {
      client: target,
      status: "failed",
      detail: `a server called "${spec.name}" already exists here and is not one of ours — it would shadow the plugin. Remove or rename it, then run connect again.`,
    };
  }

  const marketplace = ensureMarketplace(bin);
  if (marketplace) return { client: target, status: "failed", detail: marketplace };

  const result = run(bin, [
    "plugin",
    "install",
    `${PLUGIN}@${MARKETPLACE}`,
    "--config",
    `api_key=${spec.env.BRAIN_MCP_API_KEY ?? ""}`,
    "--config",
    `backend_url=${spec.env.BRAIN_MCP_BACKEND_URL ?? ""}`,
    "--json",
  ]);
  if (result.code !== 0) {
    return {
      client: target,
      status: "failed",
      detail: looksUnsupported(result)
        ? "this version of Claude Code cannot install plugins non-interactively — update it, then run connect again"
        : reasonFrom(result),
    };
  }
  const detail =
    shadow === "removed"
      ? `plugin ${PLUGIN} installed (removed the old server that was shadowing it)`
      : `plugin ${PLUGIN} installed, key in your keychain`;
  return { client: target, status: "configured", detail };
}

/**
 * Remove a user-scoped MCP server that would shadow the plugin.
 *
 * Returns what it found: `none`, `removed` (it was ours), or `foreign` (it was
 * not, and deleting someone else's configuration is not this tool's call).
 */
function clearShadowingServer(bin: string, name: string): "none" | "removed" | "foreign" {
  const listed = run(bin, ["mcp", "list", "--json"], { timeoutMs: 30_000 });
  const entry = findServer(jsonFrom(listed), name);
  if (!entry) return "none";
  if (!isOurs(entry)) return "foreign";
  const removed = run(bin, ["mcp", "remove", name, "-s", "user"], {
    timeoutMs: 20_000,
  });
  return removed.code === 0 ? "removed" : "foreign";
}

/**
 * A server as another client's `--json` output describes it.
 *
 * Everything optional, because this is a shape *they* control: the point of
 * naming it is to state which fields we read, so a missing one is a narrowing
 * failure here rather than an `undefined` surfacing later as a wrong decision
 * about whether to delete somebody's configuration.
 */
type ListedServer = {
  readonly command?: string;
  readonly args?: readonly string[];
};

/** Either `{ "<name>": {…} }` or `{ servers: { "<name>": {…} } }`. */
type ServerListing = {
  readonly servers?: Readonly<Record<string, unknown>>;
} & Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asListedServer(value: unknown): ListedServer | undefined {
  if (!isRecord(value)) return undefined;
  const command = typeof value.command === "string" ? value.command : undefined;
  const args = Array.isArray(value.args)
    ? value.args.filter((a): a is string => typeof a === "string")
    : undefined;
  return { command, args };
}

/** The named server out of a client's `--json` listing. */
function findServer(parsed: unknown, name: string): ListedServer | undefined {
  if (!isRecord(parsed)) return undefined;
  const listing = parsed as ServerListing;
  const servers = isRecord(listing.servers) ? listing.servers : listing;
  return asListedServer(servers[name]);
}

/**
 * Whether a server entry is one this tool wrote.
 *
 * Matched on the package it runs, not on its name. The name is how a collision
 * happens in the first place, so it cannot also be the evidence of ownership —
 * and getting this wrong in the permissive direction means deleting a server
 * somebody else configured.
 */
function isOurs(entry: ListedServer | undefined): boolean {
  if (!entry) return false;
  const text = [entry.command ?? "", ...(entry.args ?? [])].join(" ");
  return text.includes(SERVER_PACKAGE);
}

/** Register the marketplace, replacing a stale one. Returns a failure message. */
function ensureMarketplace(bin: string): string | undefined {
  const added = run(bin, ["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
  if (added.code === 0) return undefined;

  const text = `${added.stderr} ${added.stdout}`.toLowerCase();
  const alreadyThere = text.includes("already") || text.includes("exists");
  if (!alreadyThere) return reasonFrom(added);

  // Already registered. Re-point it, in case it is an older source — the
  // plugin used to ship from the MCP server's own repo.
  run(bin, ["plugin", "marketplace", "remove", MARKETPLACE], {
    timeoutMs: 20_000,
  });
  const readded = run(bin, ["plugin", "marketplace", "add", MARKETPLACE_SOURCE]);
  return readded.code === 0 ? undefined : reasonFrom(readded);
}

/** What `target` currently has configured, for `doctor`. */
export function inspect(
  target: ClientTarget,
  name: string,
): { configured: boolean; where: string } {
  const writer = target.writer;
  switch (writer.kind) {
    case "json":
      return {
        configured: readServer(writer.path, name) !== undefined,
        where: writer.path,
      };
    case "cli": {
      const listed = run(writer.bin, ["mcp", "list"], { timeoutMs: 30_000 });
      return {
        configured: !listed.missing && listed.stdout.includes(name),
        where: `\`${writer.bin} mcp list\``,
      };
    }
    case "plugin": {
      const listed = run(writer.bin, ["plugin", "list", "--json"], {
        timeoutMs: 30_000,
      });
      return {
        configured: !listed.missing && `${listed.stdout}`.includes(PLUGIN),
        where: `plugin ${PLUGIN}@${MARKETPLACE}`,
      };
    }
  }
}

export { SERVER_PACKAGE as serverPackage };
