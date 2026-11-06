# Packaging, one directory per client

Everything in here is **packaging**. The content it packages — the skills —
lives once, in `../skills`, and each client's directory reaches it rather than
holding a copy.

| directory | what it is |
|---|---|
| `claude-code/` | a Claude Code plugin: `.claude-plugin/plugin.json` and a `skills` symlink. Registered through `../.claude-plugin/marketplace.json` |

Clients with no directory here are configured by the CLI writing their config
file directly (`src/clients/`), because they have no package format to publish
into. A client gets a directory here only when it has one.

## Why `skills` is a symlink

A Claude Code plugin's `skills` path must start with `./` — the manifest is
rejected otherwise, so it cannot reach up to a shared directory. The
alternatives were a second copy of every skill, or a link.

A second copy drifts. It already had: `skills/` and `plugins/brain/skills/`
were identical with nothing keeping them that way, which is the same defect
that has bitten `dashboard_url`, `preferences_url` and `help_url` elsewhere in
this codebase.

**The caveat is Windows.** Git recreates symlinks on clone only where the
platform and `core.symlinks` allow it; on a Windows checkout without developer
mode the link may land as a text file holding a path, and the plugin's skills
would not load. Verified working on macOS from a marketplace clone. If that
becomes a real complaint, the fallback is a generated copy plus a test that it
matches — the pattern `scripts/build-tool-index.py` already uses — not a
hand-maintained second copy.
