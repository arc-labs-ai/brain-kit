# brain-kit

One command to give the agents on your machine a memory they keep between
sessions.

```bash
npx @brain-db/cli
```

It opens your browser, asks you to confirm a code shown in your terminal, and
configures every MCP client it finds — the Brain MCP server, the Claude Code
plugin, and the skills that tell an agent *when* memory is worth writing. No
key is copied by hand, and nothing is written until a real credential is in
hand.

```
  brain connect
  Give the agents on this machine a memory they keep between sessions.

  backend    https://api.stg.arc-labs.ai
  machine    your-laptop
  clients    Claude Code, Codex CLI, Claude Desktop

  approve
    Your browser will ask you to confirm the code below. Approving creates
    an API key in your account and sends it to this machine — nothing is
    created until you do.

  ┌──────────────────────────────────────────┐
  │   Confirm this code in your browser      │
  │                                          │
  │                WXYZ-2345                 │
  │                                          │
  └──────────────────────────────────────────┘

  granted
  namespace  acme / default
  key        brain_live_…  (not shown)

  configured
    ✓ Claude Code       plugin brain installed, key in your keychain
    ✓ Codex CLI         via `codex mcp add`
    ✓ Claude Desktop    …/claude_desktop_config.json
    ✓ skill: brain-memory  ~/.agents/skills/brain-memory

  next
    Restart Claude Code and Codex CLI and Claude Desktop.
    Then ask your agent:
      "remember that I prefer pnpm over npm"
      "what do you remember about my tooling?"
```

## What it is, and what `@brain-db/mcp` is

Two packages, two jobs:

| | |
|---|---|
| **`@brain-db/cli`** (this repo) | Sets a machine up. One-shot, interactive, opens a browser. |
| **`@brain-db/mcp`** | The MCP server an agent starts on every cold start. You do not install it directly; this configures it. |

They are separate because their lifecycles are opposite. The installer can
change freely — every run is somebody's first. The server is on the hot path
and should do nothing but speak the protocol.

## The code, and why you are asked for it

The approval link alone is not enough to connect a machine; the browser also
asks for a code that is printed **only** in the terminal that started the
request.

Without it, a link would be sufficient. Someone opens a session on their own
laptop, sends you the link, you are already signed in, you click *Authorize* —
and a key to **your** account arrives on **their** machine. Every screen in
that flow is truthful; you simply have no way to tell that the machine being
connected is not yours. The code does not travel in the link, so a person who
started no CLI has nothing to type.

## Is it actually working?

```bash
npx @brain-db/cli doctor
```

`doctor` does not read config files and tell you they look right. It **starts
the server and counts the tools that come back**:

```
  brain doctor
  Reads what is configured, then runs it. The two are not the same thing.

  clients
    ✓ Claude Code        plugin brain@arc-labs
    ✓ Codex CLI          `codex mcp list`
    – Cursor             not installed on this machine

  server
    ✓ handshake          brain-mcp 0.4.0 answered with 49 tools

  verdict
    Working. Every client on this machine is set up.
```

That is not belt-and-braces. Two real bugs shipped in the predecessor to this
package and **neither was visible in any configuration file**:

1. The server's entrypoint guard compared `import.meta.url` against
   `` file://${process.argv[1]} ``, which never matches when npm installs the
   bin as a **symlink**. The process started, matched nothing, ran no server,
   and exited **0**. Clients reported a closed connection; every install step
   had reported success.
2. A user-scoped MCP server **shadows a plugin's server of the same name**.
   Installing both left the plugin enabled, its skill loading, its key unused
   in the keychain — and a different server answering.

Reading the configuration would have told you everything was fine in both
cases. Running it is the only thing that finds them.

## Options

| Flag | Meaning |
|---|---|
| `--backend <url>` | A different Brain, e.g. `http://localhost:8080` for a local brain-edge |
| `--client <id>` | Only this client: `claude-code`, `codex`, `cursor`, `claude-desktop`, `windsurf`. Repeatable, and it configures the client whether or not it was detected |
| `--key <key>` | Skip the browser and use this key. For CI and headless machines; needs `--namespace` |
| `--namespace <name>` | Namespace for `--key` |
| `--machine <name>` | What to call this machine on the approval screen |
| `--no-browser` | Print the URL instead of opening one |
| `--dry-run` | Say what would change, write nothing |

## The skills

An MCP server is tools. A tool surface with no skill beside it is one an agent
picks wrongly from — **49 tool definitions load on every turn**, and without
guidance the agent reaches for `memory_list` when it meant `recall`, or never
discovers the 41 tools that are not `remember`.

So the skills are the other half of the product, and they are organised by the
**work** rather than by the server's file layout:

| skill | the work | tools |
|---|---|---|
| `brain-memory` | the core loop — store, recall, correct, reason over what is held. The entry point, and it carries a map of everything else | 8 |
| `brain-entities` | people, services, repositories as typed objects with relationships. "Who is X", "how are X and Y connected", merging duplicates | 14 |
| `brain-knowledge` | a claim is wrong, outdated or disputed. Provenance, supersession, retraction | 11 |
| `brain-schema` | declaring the types a workspace uses, and what reads new writes | 6 |
| `brain-workspace` | which workspace this is, why a recall came back empty, what a query cost | 10 |

Only the name and description of each are loaded at startup — about **985
tokens**, the price of the agent knowing the whole surface exists. A skill's
body is paid only when that work comes up, and
`skills/brain-memory/references/tool-index.md` — a one-line entry for all 49 —
only when the agent needs to know whether a capability exists at all.

That index is **generated** from the server's own `registerTool` calls by
`scripts/build-tool-index.py`. A tool renamed in the server and not in the
index is worse than no index: it sends the agent looking for something gone.

## One copy of each skill

The skills live once, in `skills/`, and reach both delivery paths from there:

```
brain-kit/
├── .claude-plugin/
│   ├── plugin.json        "skills": "./skills/"   ← the Claude Code plugin
│   └── marketplace.json   source: "."
├── skills/                ← THE source of truth
│   ├── brain-memory/{SKILL.md, references/}
│   ├── brain-entities/SKILL.md
│   └── …
└── src/                   the CLI, which copies them to ~/.agents/skills
```

**The repository root is the plugin.** That is what lets one `skills/` serve
both: a plugin's `skills` path must start with `./` and cannot escape the
plugin root, so the alternatives were a second copy under `plugins/brain/` or
a symlink. There was a second copy, and the two were already identical with
nothing keeping them that way — the same drift that has bitten this codebase
in three other places.

Adding another client later means another packaging manifest pointing at the
same `skills/`, never another copy of the skills.

## What gets configured where

| Client | MCP server | Skills |
|---|---|---|
| Claude Code | the **plugin** — carries the server, the skill, and the key in your OS keychain | bundled with the plugin |
| Codex CLI | `codex mcp add` (it owns its TOML) | `~/.agents/skills` |
| Cursor | `~/.cursor/mcp.json` | `~/.agents/skills` |
| Claude Desktop | `…/claude_desktop_config.json` | — |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `~/.agents/skills` |

Claude Code is the asymmetric one, and deliberately: a user-scoped MCP server
shadows a plugin's server of the same name, so writing one beside the plugin
would break the thing we just installed. If an older install left such a
server behind, this removes it — but only when it matches *our* signature. A
`brain` server somebody else configured is reported, never deleted.

Skills go to `~/.agents/skills`, which Codex reads as its USER tier and Cursor,
Copilot and Gemini CLI read too. One authored copy reaches all of them. A skill
already there that this tool did not install is left alone.

Every JSON file is merged, not replaced: existing servers are preserved, a
backup is written to `<file>.brain-backup` before the first change, the write
is atomic, and a file that cannot be parsed is **refused** rather than
overwritten — a trailing comma in your config is not permission to delete the
rest of it.

## Design notes

- [docs/TIMERS.md](docs/TIMERS.md) — every timer in the handoff and why it is
  there, which timers were removed, and the bug that audit turned up.

## License

Apache-2.0
