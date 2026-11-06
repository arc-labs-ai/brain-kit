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

/** What gets written into a client's config. */
export type ServerSpec = {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
};

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
      docs: "https://developers.openai.com/codex/mcp",
    },
    {
      id: "cursor",
      label: "Cursor",
      writer: { kind: "json", path: join(home, ".cursor", "mcp.json") },
      evidence: [join(home, ".cursor")],
      readsSkills: true,
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
