/**
 * Detecting and configuring each client.
 */

import { existsSync } from "node:fs";
import { WriteError, mergeServer, readServer } from "./json.js";
import { available, jsonFrom, looksUnsupported, reasonFrom, run } from "./run.js";
import type { ClientTarget, ServerSpec } from "./targets.js";

/**
 * The npm package run by a **self-hosted** install.
 *
 * Only reached on the stdio path. The normal install writes a remote server
 * and runs nothing locally.
 */
export const SERVER_PACKAGE = "@brain-db/mcp";

/**
 * The environment variable Codex reads a bearer token from.
 *
 * `codex mcp add --url` accepts `--bearer-token-env-var <NAME>` and has no
 * option for a literal token: its config stores the variable's NAME, and the
 * token is read from the environment at launch. So this is not a stylistic
 * choice about where to keep the key — it is the only thing that client
 * supports, and the user has to export it.
 */
export const BEARER_ENV_VAR = "BRAIN_API_KEY";

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

  // Can this client even express this transport? Asked before anything is
  // written, because the answer for Claude Code is "yes" and the answer for
  // Claude Desktop is "no, and writing it anyway loses your other servers".
  if (!target.transports.includes(spec.transport)) {
    const step = target.manual?.(spec);
    return {
      client: target,
      status: "skipped",
      detail: step
        ? `cannot be configured for ${spec.transport} from a config file — ${step}`
        : `does not support ${spec.transport} servers`,
    };
  }

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
    const result = mergeServer(
      path,
      spec.name,
      spec.transport === "http"
        ? { url: spec.url, headers: { Authorization: `Bearer ${spec.apiKey}` } }
        : { command: spec.command, args: spec.args, env: spec.env },
    );
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
  if (spec.transport === "http") {
    // No literal token: this client has no option for one. The key never
    // reaches its config file or this argv — only the variable's name does.
    args.push("--url", spec.url, "--bearer-token-env-var", BEARER_ENV_VAR);
  } else {
    for (const [key, value] of Object.entries(spec.env)) {
      args.push("--env", `${key}=${value}`);
    }
    args.push("--", spec.command, ...spec.args);
  }

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
  return {
    client: target,
    status: "configured",
    detail:
      spec.transport === "http"
        ? `via \`${bin} mcp add --url\` — reads the key from $${BEARER_ENV_VAR}`
        : `via \`${bin} mcp add\``,
  };
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

  const shadow = clearShadowingServer(bin, spec.name, spec);
  if (shadow === "foreign") {
    return {
      client: target,
      status: "failed",
      detail: `a server called "${spec.name}" already exists here and is not one of ours — it would shadow the plugin. Remove or rename it, then run connect again.`,
    };
  }

  const marketplace = ensureMarketplace(bin);
  if (marketplace) return { client: target, status: "failed", detail: marketplace };

  const id = `${PLUGIN}@${MARKETPLACE}`;

  // Install carries NO secret on its command line. A required option left
  // unset is reported and does not block the install, which is what makes the
  // two-step possible.
  const installed = run(bin, ["plugin", "install", id, "--json"]);
  if (installed.code !== 0) {
    return {
      client: target,
      status: "failed",
      detail: looksUnsupported(installed)
        ? "this version of Claude Code cannot install plugins non-interactively — update it, then run connect again"
        : reasonFrom(installed),
    };
  }

  const stored = storePluginConfig(bin, id, spec);
  if (stored.status === "failed") {
    return { client: target, status: "failed", detail: stored.detail };
  }

  const notes = [stored.detail];
  if (shadow === "removed") {
    notes.push("removed the old server that was shadowing it");
  }
  return {
    client: target,
    status: "configured",
    detail: `plugin ${PLUGIN} installed — ${notes.join("; ")}`,
  };
}

/**
 * Hand the plugin its credential.
 *
 * **Over stdin, not on the command line.** `--config api_key=…` works and was
 * the first implementation, but a process's arguments are readable by every
 * other process on the machine — `ps` shows them — and they land in audit logs
 * and process accounting. A credential has no business being an argv entry
 * when the tool offers a way to pipe it.
 *
 * Falls back to `--config` on a version without `--values-stdin`, because a
 * working install with a brief argv exposure beats no install at all — and it
 * says which path it took, so the trade is visible rather than silent.
 */
function storePluginConfig(
  bin: string,
  id: string,
  spec: ServerSpec,
): { status: "configured" | "failed"; detail: string } {
  const config = pluginConfig(spec);
  const values = JSON.stringify(config);

  const piped = run(bin, ["plugin", "configure", id, "--values-stdin"], {
    input: `${values}\n`,
  });
  if (piped.code === 0) {
    return { status: "configured", detail: "key in your keychain" };
  }
  if (!looksUnsupported(piped)) {
    return { status: "failed", detail: reasonFrom(piped) };
  }

  const viaArgs = run(bin, [
    "plugin",
    "install",
    id,
    ...Object.entries(config).flatMap(([key, value]) => ["--config", `${key}=${value}`]),
    "--json",
  ]);
  return viaArgs.code === 0
    ? {
        status: "configured",
        detail:
          "key in your keychain (passed as an argument — this Claude Code is too old to take it on stdin)",
      }
    : { status: "failed", detail: reasonFrom(viaArgs) };
}

/**
 * The `userConfig` values the plugin manifest substitutes into its server.
 *
 * The manifest declares an HTTP server whose `url` and `Authorization` header
 * are both `${user_config.…}` references, so these two values ARE the server:
 * the endpoint is stored rather than baked into the manifest, which is what
 * lets one published plugin serve staging, production and somebody's own
 * deployment. `backend_url` is carried for the skills, which cite it when
 * telling someone where their memories live.
 */
function pluginConfig(spec: ServerSpec): Record<string, string> {
  return spec.transport === "http"
    ? { api_key: spec.apiKey, mcp_url: spec.url, backend_url: spec.backendUrl }
    : {
        api_key: spec.env.BRAIN_MCP_API_KEY ?? "",
        backend_url: spec.env.BRAIN_MCP_BACKEND_URL ?? "",
      };
}

/**
 * Remove a user-scoped MCP server that would shadow the plugin.
 *
 * Returns what it found: `none`, `removed` (it was ours), or `foreign` (it was
 * not, and deleting someone else's configuration is not this tool's call).
 */
function clearShadowingServer(
  bin: string,
  name: string,
  spec: ServerSpec,
): "none" | "removed" | "foreign" {
  const listed = run(bin, ["mcp", "list", "--json"], { timeoutMs: 30_000 });
  const entry = findServer(jsonFrom(listed), name);
  if (!entry) return "none";
  if (!isOurs(entry, spec)) return "foreign";
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
  readonly url?: string;
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
  const url = typeof value.url === "string" ? value.url : undefined;
  return { command, args, url };
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
function isOurs(entry: ListedServer | undefined, spec: ServerSpec): boolean {
  if (!entry) return false;
  // A remote server is ours when it points at the endpoint we are installing.
  // Checked against the resolved spec rather than a compiled-in hostname, so a
  // developer's own deployment is recognised as theirs instead of being
  // reported as a stranger's server they have to go and delete by hand.
  if (entry.url && spec.transport === "http") {
    return entry.url.replace(/\/+$/, "") === spec.url.replace(/\/+$/, "");
  }
  const text = [entry.command ?? "", ...(entry.args ?? [])].join(" ");
  return text.includes(SERVER_PACKAGE);
}

/**
 * Make sure the marketplace is registered and points where we expect.
 *
 * Returns a failure message, or `undefined` when it is ready.
 *
 * ## Why this reads the list instead of the add's output
 *
 * The first version ran `marketplace add` and, on failure, decided whether it
 * was already registered by looking for "already" or "exists" in the output.
 * The error for a repository that does not exist is:
 *
 *     Please make sure you have the correct access rights
 *     and the repository exists.
 *
 * — which contains "exists". So a MISSING repo read as "already registered",
 * and the next step was `marketplace remove`, which uninstalls every plugin
 * from that marketplace and deletes its stored secrets. A substring match on
 * somebody else's prose decided whether to run a destructive command.
 *
 * `marketplace list --json` answers the question directly.
 */
function ensureMarketplace(bin: string): string | undefined {
  const registered = findMarketplace(bin, MARKETPLACE);

  if (registered === "ours") return undefined;

  if (registered === "foreign") {
    // Registered, but from somewhere else — a local checkout, or an older
    // source. Re-pointing means `marketplace remove`, which UNINSTALLS the
    // plugins from it and deletes their secrets. That is not a call to make
    // silently on somebody's behalf.
    return `a marketplace called "${MARKETPLACE}" is already registered from somewhere else. Re-pointing it would uninstall its plugins and delete their stored options, so it is left alone — remove it yourself if you want ${MARKETPLACE_SOURCE}.`;
  }

  const added = run(bin, ["plugin", "marketplace", "add", MARKETPLACE_SOURCE], {
    timeoutMs: 120_000,
  });
  if (added.code === 0) return undefined;
  if (added.timedOut) {
    return `adding the ${MARKETPLACE} marketplace timed out — check your network, or add it yourself with \`${bin} plugin marketplace add ${MARKETPLACE_SOURCE}\``;
  }
  return reasonFrom(added);
}

/** Whether `name` is registered, and whether it points at our source. */
function findMarketplace(bin: string, name: string): "ours" | "foreign" | "absent" {
  const listed = run(bin, ["plugin", "marketplace", "list", "--json"], {
    timeoutMs: 30_000,
  });
  const parsed = jsonFrom(listed);
  if (!Array.isArray(parsed)) {
    // Cannot tell. Treat as absent and let `add` decide — it refuses a
    // duplicate name, which is a safe failure. Guessing "foreign" here would
    // refuse to install on every machine whose CLI predates `--json`.
    return "absent";
  }
  const entry = parsed.find(
    (m): m is Record<string, unknown> =>
      typeof m === "object" && m !== null && (m as { name?: unknown }).name === name,
  );
  if (!entry) return "absent";
  // A GitHub marketplace reports `repo`; one added from a checkout reports
  // `path`. Both are "ours" when they name the source we would add — which is
  // how a developer working from a local clone avoids being told their own
  // marketplace belongs to somebody else.
  return entry.repo === MARKETPLACE_SOURCE || entry.path === MARKETPLACE_SOURCE
    ? "ours"
    : "foreign";
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
