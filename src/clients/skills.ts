/**
 * Installing the portable skills.
 *
 * ## Why skills at all
 *
 * The MCP server exposes a large tool surface. Tool definitions load on every
 * turn, so a big surface is both a standing context cost and a correctness
 * hazard — an agent handed forty-nine tools and no guidance picks the wrong
 * one. The skill is what turns that surface into a capability: when to store
 * something, when to look, what the answer shapes mean, what never to put in
 * a memory.
 *
 * That is why this installer exists and the MCP package's did not. A server is
 * tools; a setup tool ships tools *and* the knowledge of how to use them.
 *
 * ## Why one directory serves nearly every client
 *
 * `~/.agents/skills` is the cross-tool convention: Codex reads it as its USER
 * tier, and Cursor, Copilot and Gemini CLI read the same path. So one authored
 * copy of each skill reaches all of them, and the per-client work is zero.
 * Claude Code is the exception by design — its plugin carries the same skills,
 * versioned with the plugin, so it is not given a second copy here.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKETPLACE, PLUGIN } from "./install.js";

/** The shared skills directory every modern agent CLI reads. */
export function skillsDir(): string {
  return join(homedir(), ".agents", "skills");
}

/**
 * Where this package's own skills live on disk.
 *
 * Resolved from this module's URL, not from `process.cwd()` or `argv[1]`: the
 * bin is installed as a symlink, so both of those point somewhere unrelated to
 * the package's files.
 */
export function bundledSkillsDir(): string {
  // dist/clients/skills.js → ../../skills
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "skills");
}

export type SkillDrift = {
  name: string;
  locations: string[];
};

type SkillDriftPaths = {
  bundled?: string;
  portable?: string;
  pluginCache?: string;
};

/**
 * Find delivered skill copies whose instructions differ from the shipped copy.
 *
 * A client can otherwise appear healthy while its users receive different
 * answers for the same tool, depending only on which copy it loaded.
 */
export function skillDrift(paths: SkillDriftPaths = {}): SkillDrift[] {
  const reference = paths.bundled ?? bundledSkillsDir();
  const portable = paths.portable ?? skillsDir();
  const pluginCache =
    paths.pluginCache ??
    join(homedir(), ".claude", "plugins", "cache", MARKETPLACE, PLUGIN);
  let names: string[];
  try {
    names = readdirSync(reference);
  } catch {
    return [];
  }

  const drift: SkillDrift[] = [];
  for (const name of names) {
    const skill = join(reference, name);
    if (!isSkill(skill)) continue;

    const referenceBytes = readBytes(join(skill, "SKILL.md"));
    if (!referenceBytes) continue;
    const copies = [
      join(portable, name, "SKILL.md"),
      ...pluginSkillPaths(pluginCache, name),
    ];
    const differing = copies.filter((path) => {
      const bytes = readBytes(path);
      return bytes !== undefined && !bytesEqual(referenceBytes, bytes);
    });
    if (differing.length > 0) {
      drift.push({ name, locations: [join(skill, "SKILL.md"), ...differing] });
    }
  }
  return drift;
}

export type SkillResult = {
  name: string;
  status: "installed" | "updated" | "skipped" | "failed";
  detail: string;
};

/**
 * A marker file written beside each skill we install.
 *
 * Without it there is no way to tell a skill this tool put there from one the
 * user wrote by hand under the same name — and that distinction decides
 * whether overwriting it is an update or data loss.
 */
const MARKER = ".brain-installed";

/** Install every bundled skill into the shared directory. */
export function installSkills(dryRun: boolean): SkillResult[] {
  const source = bundledSkillsDir();
  if (!existsSync(source)) return [];

  const target = skillsDir();
  const results: SkillResult[] = [];

  for (const name of readdirSync(source)) {
    const from = join(source, name);
    if (!isSkill(from)) continue;
    const to = join(target, name);
    const existed = existsSync(to);

    if (existed && !isOurs(to)) {
      // Someone has a skill of their own under this name. Theirs wins; saying
      // so is more useful than silently replacing it or silently doing nothing.
      results.push({
        name,
        status: "skipped",
        detail: `${to} already exists and was not installed by us — left alone`,
      });
      continue;
    }

    if (dryRun) {
      results.push({
        name,
        status: "skipped",
        detail: `would ${existed ? "update" : "install"} ${to}`,
      });
      continue;
    }

    try {
      // Replace wholesale rather than merge: a skill is a directory of files
      // that version together, and a half-updated one is a skill whose
      // SKILL.md references a reference file that is no longer there.
      if (existed) rmSync(to, { recursive: true, force: true });
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
      writeMarker(to);
      results.push({
        name,
        status: existed ? "updated" : "installed",
        detail: to,
      });
    } catch (err) {
      results.push({ name, status: "failed", detail: String(err) });
    }
  }
  return results;
}

/** Remove only the skills this tool installed. */
export function removeSkills(): SkillResult[] {
  const target = skillsDir();
  if (!existsSync(target)) return [];
  const results: SkillResult[] = [];
  for (const name of readdirSync(target)) {
    const path = join(target, name);
    if (!isSkill(path) || !isOurs(path)) continue;
    try {
      rmSync(path, { recursive: true, force: true });
      results.push({ name, status: "installed", detail: `removed ${path}` });
    } catch (err) {
      results.push({ name, status: "failed", detail: String(err) });
    }
  }
  return results;
}

/** Which of our skills are currently installed, for `doctor`. */
export function installedSkills(): string[] {
  const target = skillsDir();
  if (!existsSync(target)) return [];
  return readdirSync(target).filter((name) => {
    const path = join(target, name);
    return isSkill(path) && isOurs(path);
  });
}

/** A skill is a directory with a `SKILL.md` in it — the format's whole rule. */
function isSkill(path: string): boolean {
  try {
    return statSync(path).isDirectory() && existsSync(join(path, "SKILL.md"));
  } catch {
    return false;
  }
}

function pluginSkillPaths(cache: string, name: string): string[] {
  try {
    return readdirSync(cache, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(cache, entry.name, "skills", name, "SKILL.md"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

function readBytes(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function bytesEqual(left: Buffer, right: Buffer): boolean {
  return (
    left.length === right.length && left.every((byte, index) => byte === right[index])
  );
}

function isOurs(path: string): boolean {
  return existsSync(join(path, MARKER));
}

function writeMarker(path: string): void {
  // Content is for a human who finds the file and wonders what wrote it.
  const note = `Installed by @brain-db/cli. Safe to delete; it only marks this
skill as ours, so a later run knows it may replace it rather than
overwriting something you wrote.
`;
  try {
    writeFileSync(join(path, MARKER), note, "utf8");
  } catch {
    // A missing marker means the next run treats this skill as the user's and
    // leaves it alone — the safe direction.
  }
}

/** The `name:` of a skill's SKILL.md, for reporting. */
export function skillName(path: string): string | undefined {
  try {
    const raw = readFileSync(join(path, "SKILL.md"), "utf8");
    return /^name:\s*(\S+)\s*$/m.exec(raw)?.[1];
  } catch {
    return undefined;
  }
}
