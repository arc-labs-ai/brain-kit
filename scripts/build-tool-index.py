#!/usr/bin/env python3
"""Regenerate the skill tool index from the MCP server's own registrations.

The index tells an agent whether a capability exists at all. A tool renamed in
the server and not here is worse than no index — it sends the agent looking for
something that is gone.

    python3 scripts/build-tool-index.py [path-to-brain-mcp]

Reads `src/server/tools/*.ts` from the brain-mcp checkout (default: a sibling
directory) and writes `skills/brain-memory/references/tool-index.md`.

This is a CROSS-REPO generator, so nothing in this repo's CI can prove the
index is current — only that it is internally consistent (see
`test/tool-index.test.ts`). Run this when the server's surface changes.
"""

import pathlib
import re
import sys

# Which skill explains the work each group of tools belongs to.
SKILL_FOR = {
    "memory": "brain-memory",
    "cognitive": "brain-memory",
    "entities": "brain-entities",
    "graph": "brain-entities",
    "knowledge": "brain-knowledge",
    "schema": "brain-schema",
    "identity": "brain-workspace",
    "workspace": "brain-workspace",
    "query": "brain-workspace",
}

# Presentation order: the common loop first, the specialised surface after.
ORDER = [
    "memory", "cognitive", "entities", "graph",
    "knowledge", "schema", "identity", "workspace", "query",
]

TITLE = {
    "memory": "Store and retrieve",
    "cognitive": "Reason over what is held",
    "entities": "Entities",
    "graph": "Graph edges",
    "knowledge": "Statements and relations",
    "schema": "Schema",
    "identity": "Identity and capability",
    "workspace": "Sessions and spaces",
    "query": "Query diagnostics",
}

HEADER = """# Every Brain tool, by job

**Generated** by `scripts/build-tool-index.py` from the server's own
`registerTool` calls. Do not hand-edit.

This is for deciding **whether a capability exists**, not for learning how to
use one. Each group names the skill that explains the work it belongs to, and
that skill is where the judgement lives.
"""


def tools_in(source: str) -> list[tuple[str, str]]:
    """Every `(name, first sentence)` registered in one tools file."""
    out = []
    for name in re.findall(r'registerTool\(\s*"([a-z_]+)"', source):
        match = re.search(
            r'registerTool\(\s*"' + name + r'".*?description:\s*((?:\s*"[^"]*"\s*\+?)+)',
            source,
            re.S,
        )
        summary = ""
        if match:
            # Descriptions are written as concatenated string literals.
            joined = "".join(re.findall(r'"([^"]*)"', match.group(1)))
            joined = re.sub(r"\s+", " ", joined).strip()
            # First sentence only: the index is for deciding, not for using.
            summary = joined.split(". ")[0].rstrip(".") + "."
        out.append((name, summary))
    return out


def main() -> int:
    here = pathlib.Path(__file__).resolve().parent.parent
    server = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here.parent / "brain-mcp"
    tools_dir = server / "src/server/tools"
    if not tools_dir.is_dir():
        print(f"no tools directory at {tools_dir}", file=sys.stderr)
        print("pass the path to a brain-mcp checkout as the first argument", file=sys.stderr)
        return 1

    groups, total = [], 0
    for domain in ORDER:
        path = tools_dir / f"{domain}.ts"
        if not path.exists():
            print(f"missing {path.name}; the server's layout has changed", file=sys.stderr)
            return 1
        entries = tools_in(path.read_text())
        total += len(entries)
        groups.append((domain, entries))

    # A file this generator does not know about would be silently dropped.
    known = {f"{d}.ts" for d in ORDER}
    extra = sorted(p.name for p in tools_dir.glob("*.ts") if p.name not in known)
    if extra:
        print(f"unmapped tool files: {', '.join(extra)}", file=sys.stderr)
        print("add them to ORDER and SKILL_FOR, or they will be missing from the index",
              file=sys.stderr)
        return 1

    lines = [HEADER, f"\n**{total} tools.**\n"]
    for domain, entries in groups:
        lines.append(f"\n## {TITLE[domain]} — `{SKILL_FOR[domain]}`\n")
        lines += [f"- **`{name}`** — {summary}" for name, summary in entries]
        lines.append("")

    out = here / "skills/brain-memory/references/tool-index.md"
    out.write_text("\n".join(lines) + "\n")
    print(f"{out.relative_to(here)}: {total} tools")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
