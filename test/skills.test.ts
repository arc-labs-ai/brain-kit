import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shipped skills, checked against the Agent Skills spec and against each
 * other.
 *
 * These files are the only thing that tells an agent Brain has a surface
 * beyond `remember` and `recall`. Nothing at runtime validates them: a skill
 * whose `name` disagrees with its directory is silently ignored by the
 * clients that load it, and a reference link that points nowhere costs a read
 * and returns nothing — both fail quietly, in somebody else's session.
 */

const SKILLS_DIR = join(import.meta.dirname, "..", "skills");
const INDEX = join(SKILLS_DIR, "brain-memory/references/tool-index.md");

function skillDirs(): string[] {
  return readdirSync(SKILLS_DIR).filter((name) =>
    statSync(join(SKILLS_DIR, name)).isDirectory(),
  );
}

function frontmatter(dir: string): Record<string, string> {
  const body = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  if (!match) throw new Error(`${dir}/SKILL.md has no frontmatter`);
  const out: Record<string, string> = {};
  // Values may wrap across lines; a new key starts at column zero.
  let key = "";
  for (const line of (match[1] ?? "").split("\n")) {
    const kv = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (kv?.[1]) {
      key = kv[1];
      out[key] = kv[2] ?? "";
    } else if (key) {
      out[key] = `${out[key]} ${line.trim()}`.trim();
    }
  }
  return out;
}

describe("every shipped skill", () => {
  it("there is more than one, covering more than the core loop", () => {
    // The whole point of this set: `remember`/`recall` is 2 of 49 tools, and
    // a single skill left the other 47 invisible.
    expect(skillDirs().length).toBeGreaterThan(1);
  });

  for (const dir of skillDirs()) {
    describe(dir, () => {
      it("has a SKILL.md", () => {
        expect(existsSync(join(SKILLS_DIR, dir, "SKILL.md"))).toBe(true);
      });

      /** The spec is explicit: `name` must match the parent directory. */
      it("names itself after its directory", () => {
        expect(frontmatter(dir).name).toBe(dir);
      });

      it("has a name the spec accepts", () => {
        const name = frontmatter(dir).name ?? "";
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(64);
        expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      });

      /**
       * The description is the ONLY thing loaded at startup, and it is what
       * decides whether the skill ever fires. An empty or over-long one is a
       * skill that never activates, or one that costs every session.
       */
      it("has a description within the spec's bounds", () => {
        const description = frontmatter(dir).description ?? "";
        expect(description.length).toBeGreaterThan(80);
        expect(description.length).toBeLessThanOrEqual(1024);
      });

      /** Progressive disclosure: the body is paid on every activation. */
      it("keeps its body under the recommended length", () => {
        const lines = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8").split(
          "\n",
        ).length;
        expect(lines).toBeLessThan(500);
      });

      it("has no reference link that points nowhere", () => {
        const body = readFileSync(join(SKILLS_DIR, dir, "SKILL.md"), "utf8");
        for (const [, target] of body.matchAll(/\]\((references\/[^)]+)\)/g)) {
          expect(
            existsSync(join(SKILLS_DIR, dir, target as string)),
            `${dir}/SKILL.md links to ${target}, which does not exist`,
          ).toBe(true);
        }
      });
    });
  }
});

describe("the tool index", () => {
  const body = () => readFileSync(INDEX, "utf8");

  it("exists, because brain-memory points at it", () => {
    expect(existsSync(INDEX)).toBe(true);
  });

  /**
   * Cross-repo, so nothing here can prove the index matches the live server —
   * only that it is internally consistent. Freshness comes from re-running
   * `scripts/build-tool-index.py`.
   */
  it("agrees with its own count", () => {
    const claimed = Number(/\*\*(\d+) tools\.\*\*/.exec(body())?.[1]);
    const listed = [...body().matchAll(/^- \*\*`([a-z_]+)`\*\*/gm)].length;
    expect(claimed).toBe(listed);
  });

  it("lists each tool exactly once", () => {
    const names = [...body().matchAll(/^- \*\*`([a-z_]+)`\*\*/gm)].map((m) => m[1]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("only sends the reader to skills that exist", () => {
    const dirs = new Set(skillDirs());
    for (const [, named] of body().matchAll(/^## .+ — `([a-z-]+)`$/gm)) {
      expect(
        dirs.has(named as string),
        `the index routes to ${named}, which is not a skill`,
      ).toBe(true);
    }
  });

  /** Every tool must be reachable from some group. */
  it("routes every tool to a skill", () => {
    const groups = [...body().matchAll(/^## .+ — `([a-z-]+)`$/gm)].length;
    expect(groups).toBeGreaterThan(0);
    expect(body()).not.toMatch(/^- \*\*`[a-z_]+`\*\* — \s*$/m);
  });
});
