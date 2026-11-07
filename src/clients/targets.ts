/**
 * The clients this installer knows how to configure, and what "configure"
 * means for each.
 *
 * The important asymmetry is Claude Code. Every other client gets an MCP
 * server written into a config file. Claude Code gets a **plugin** — and that
 * is not a stylistic preference, it is a correctness fix:
 *
 * 1. A user-scoped MCP server **shadows a plugin's server of the same name.**
 *    Install both and the plugin is enabled, its skill loads, its key sits
 *    unused in the OS keychain, and the server actually answering is the one
 *    with a plaintext key in a config file. Every surface reports success. The
 *    only way to notice is to spot something missing from a list.
 * 2. The plugin carries the **skill**, and 49 MCP tools with no skill is worse
 *    than useless — the agent picks the wrong one. The tools are the
 *    capability; the skill is the knowledge of when to use it.
 * 3. `claude plugin install --config` stores a value marked `sensitive` the
 *    same way the interactive flow does: in the **OS keychain**, not in a file.
 *
 * So for Claude Code the plugin IS the install, and writing a server beside it
 * would break the thing we just set up.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

/**
 * A **remote** MCP server — the normal case.
 *
 * Brain hosts the MCP server. A client dials it over Streamable HTTP with the
 * user's own key as a bearer and runs no local process at all: nothing to
 * install, nothing to keep up to date, and a server-side fix reaches everyone
 * without a reinstall.
 */
export type RemoteSpec = {
  transport: "http";
  name: string;
  /** The hosted endpoint, as the issuing deployment named it. */
  url: string;
  apiKey: string;
  /** The API base. Carried for the Claude Code plugin, which stores both. */
  backendUrl: string;
};

/**
 * A **local** MCP server, run as a child process — the self-hosting case.
 *
 * Only reached when the deployment that issued the key hosts no MCP server of
 * its own, or when `--stdio` asks for it. It is the slower path in every
 * respect: a cold `npx` costs ~1.3s against ~0.2s for a resolved binary, the
 * version in use is whatever that machine last fetched, and a fix ships only
 * when every user reinstalls.
 */
export type StdioSpec = {
  transport: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** What gets written into a client's config. */
export type ServerSpec = RemoteSpec | StdioSpec;

/** How a client reaches an MCP server. */
export type Transport = ServerSpec["transport"];

/** How a client is configured. */
export type Writer =
  /** Merge into a JSON file's `mcpServers`. */
  | { kind: "json"; path: string }
  /** Shell out to the client's own CLI, which owns its config format. */
  | { kind: "cli"; bin: string }
  /** Install the Claude Code plugin, which carries the server and the skill. */
  | { kind: "plugin"; bin: string };

export type ClientTarget = {
  id: string;
  label: string;
  writer: Writer;
  /** Paths whose existence means this client is installed. */
  evidence: string[];
  /** Whether this client reads portable skills from `~/.agents/skills`. */
  readsSkills: boolean;
  /**
   * The transports this client's config format can actually express.
   *
   * Per-client and not a global assumption, because the clients genuinely
   * differ and the difference is invisible until something silently fails.
   * Claude Desktop is the one that matters: its config file takes stdio
   * servers only, and a `url` entry there has been reported to make it rewrite
   * the file and drop the whole `mcpServers` section on restart — so writing
   * one is not a harmless no-op, it destroys the user's other servers.
   *
   * A client that cannot express the transport in hand is reported with the
   * manual step for it, never written to and hoped for.
   */
  transports: Transport[];
  /**
   * How to configure a transport this client cannot be written to
   * automatically. Receives the resolved spec so the message can name the real
   * endpoint rather than a placeholder.
   */
  manual?: (spec: ServerSpec) => string;
  docs: string;
};

/** The per-user application-support directory for this OS. */
export function appSupport(): string {
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support");
    case "win32":
      return process.env.APPDATA ?? join(home, "AppData", "Roaming");
    default:
      return process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  }
}

/**
 * Every client, in the order they are configured.
 *
 * Claude Code first, because it is the one whose install can fail in an
 * interesting way (a plugin command, an existing marketplace) and seeing that
 * before the easy ones is more useful than after.
 */
export function targets(): ClientTarget[] {
  const home = homedir();
  const support = appSupport();
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      // The plugin, NOT `claude mcp add` — see the note at the top of this file.
      writer: { kind: "plugin", bin: "claude" },
      evidence: [join(home, ".claude"), join(home, ".claude.json")],
      // The plugin carries its own skills; it does not read the shared path.
      readsSkills: false,
      // The plugin manifest expresses either, and HTTP is what it ships.
      transports: ["http", "stdio"],
      docs: "https://docs.claude.com/en/docs/claude-code/plugins",
    },
    {
      id: "codex",
      label: "Codex CLI",
      // Its config is TOML, and `codex mcp add` owns that format. Writing TOML
      // by hand here would mean this package reimplementing a parser to edit a
      // file whose own CLI edits it correctly.
      writer: { kind: "cli", bin: "codex" },
      evidence: [join(home, ".codex")],
      readsSkills: true,
      // `codex mcp add --url` writes a streamable-HTTP server. Note that it
      // takes `--bearer-token-env-var`, never a literal token, so the remote
      // path here configures an env var rather than storing the key.
      transports: ["http", "stdio"],
      docs: "https://developers.openai.com/codex/mcp",
    },
    {
      id: "cursor",
      label: "Cursor",
      writer: { kind: "json", path: join(home, ".cursor", "mcp.json") },
      evidence: [join(home, ".cursor")],
      readsSkills: true,
      transports: ["http", "stdio"],
      docs: "https://cursor.com/docs/context/mcp",
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      writer: {
        kind: "json",
        path: join(support, "Claude", "claude_desktop_config.json"),
      },
      evidence: [join(support, "Claude")],
      // No skills support: it is a chat client, not an agent harness.
      readsSkills: false,
      // stdio ONLY — see `transports` on ClientTarget. A `url` entry in
      // `claude_desktop_config.json` is not merely ignored; it has been
      // reported to take the user's other servers with it on restart.
      transports: ["stdio"],
      manual: (spec) =>
        spec.transport === "http"
          ? `add it in Claude Desktop → Settings → Connectors → Add custom connector, using ${spec.url}`
          : "add it by hand in Settings → Developer → Edit Config",
      docs: "https://modelcontextprotocol.io/quickstart/user",
    },
    {
      id: "windsurf",
      label: "Windsurf",
      writer: {
        kind: "json",
        path: join(home, ".codeium", "windsurf", "mcp_config.json"),
      },
      evidence: [join(home, ".codeium", "windsurf")],
      readsSkills: true,
      transports: ["http", "stdio"],
      docs: "https://docs.windsurf.com/windsurf/cascade/mcp",
    },
  ];
}

/** The target with this id, if it is one we know. */
export function targetById(id: string): ClientTarget | undefined {
  return targets().find((t) => t.id === id);
}

/** Every known client id, for an error message that names the alternatives. */
export function knownIds(): string[] {
  return targets().map((t) => t.id);
}

/** A refusal with its own remedy, kept apart from how either is laid out. */
export type Refusal = { what: string; remedy: string };

/**
 * Which clients a run should touch, or a refusal naming the mistake.
 *
 * Returns the two halves separately rather than one pre-formatted string. The
 * string version embedded its own indentation, which then collided with the
 * indentation the printer adds — the kind of defect that is invisible in the
 * source and obvious the first time anyone runs it.
 *
 * Shared by every command that takes `--client`, so a typo is answered the
 * same way whether it was passed to `connect` or to `disconnect`.
 */
export function resolveClients(ids: string[]): ClientTarget[] | Refusal {
  if (ids.length === 0) return targets();
  const resolved: ClientTarget[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const target = targetById(id);
    if (target) resolved.push(target);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    return {
      what: `No client called ${unknown.map((u) => `"${u}"`).join(" or ")}.`,
      remedy: `Known clients: ${knownIds().join(", ")}`,
    };
  }
  return resolved;
}
