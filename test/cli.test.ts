/**
 * Argument parsing, and the two ways a hand-rolled parser goes quietly wrong.
 *
 * 1. A command is added to the `Parsed` union and to the word list, and the
 *    dispatcher's switch is never extended — so it parses, falls through, and
 *    the process exits having done nothing. TypeScript catches that one only
 *    because the switch is exhaustive over the union, which is why the union
 *    is written out rather than inferred from a string.
 * 2. A command exists and is not in the usage text, so the only way to find it
 *    is to read the source. The last test here is the one that fails when that
 *    happens.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Parsed, USAGE, UsageError, parse } from "../src/cli.js";

/** Every option the parser accepts, as somebody would type it. */
const OPTIONS = [
  "--backend",
  "--mcp-url",
  "--self-host",
  "--client",
  "--key",
  "--namespace",
  "--machine",
  "--no-browser",
  "--keep-skills",
  "--dry-run",
];

/** Every command word the parser accepts. */
const COMMANDS: Array<Parsed["command"]> = [
  "connect",
  "disconnect",
  "doctor",
  "help",
  "version",
];

describe("picking a command", () => {
  /** Somebody who typed `npx @brain-db/cli` wants to be set up, not helped. */
  it("treats a bare invocation as connect", () => {
    expect(parse([]).command).toBe("connect");
  });

  it("takes a leading bare word as the command", () => {
    expect(parse(["disconnect"]).command).toBe("disconnect");
    expect(parse(["doctor"]).command).toBe("doctor");
    expect(parse(["connect"]).command).toBe("connect");
  });

  it("refuses a word it does not know", () => {
    expect(() => parse(["frobnicate"])).toThrow(UsageError);
  });

  /**
   * `uninstall` is what people type when they want this gone, and it is not
   * the name of the command. Being told the name beats being handed a list.
   */
  it("names the command somebody probably meant", () => {
    expect(() => parse(["uninstall"])).toThrow(/did you mean `disconnect`/);
    expect(() => parse(["remove"])).toThrow(/did you mean `disconnect`/);
    expect(() => parse(["install"])).toThrow(/did you mean `connect`/);
    expect(() => parse(["status"])).toThrow(/did you mean `doctor`/);
  });
});

describe("options", () => {
  it("defaults to keeping nothing and writing for real", () => {
    const parsed = parse(["disconnect"]);
    expect(parsed.keepSkills).toBe(false);
    expect(parsed.dryRun).toBe(false);
  });

  it("reads --keep-skills and --dry-run", () => {
    const parsed = parse(["disconnect", "--keep-skills", "--dry-run"]);
    expect(parsed.keepSkills).toBe(true);
    expect(parsed.dryRun).toBe(true);
  });

  it("collects repeated --client", () => {
    expect(
      parse(["disconnect", "--client", "cursor", "--client", "codex"]).clients,
    ).toEqual(["cursor", "codex"]);
  });

  it("refuses an option it does not know", () => {
    expect(() => parse(["disconnect", "--purge-everything"])).toThrow(UsageError);
  });

  it("refuses an option whose value is missing", () => {
    expect(() => parse(["disconnect", "--client"])).toThrow(/needs a value/);
  });
});

describe("the usage text", () => {
  /**
   * A command nobody can discover is a command nobody runs. `help` and
   * `version` are flags in the text rather than words, so they are exempt.
   */
  it("names every command that is not a flag", () => {
    for (const command of COMMANDS) {
      if (command === "help" || command === "version") continue;
      expect(USAGE, `${command} is missing from USAGE`).toContain(command);
    }
  });

  it("names every option the parser accepts", () => {
    for (const option of OPTIONS) {
      expect(USAGE, `${option} is missing from USAGE`).toContain(option);
    }
  });
});

/**
 * The README is the page people read before they run anything, so an option
 * that exists only in `--help` is an option most users never find. This is a
 * sync test, not a style check: it fails when the two drift.
 */
describe("the README", () => {
  const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");

  it("documents every option the parser accepts", () => {
    for (const option of OPTIONS) {
      expect(readme, `${option} is missing from README.md`).toContain(`\`${option}`);
    }
  });

  it("documents every command", () => {
    for (const command of COMMANDS) {
      if (command === "help" || command === "version") continue;
      expect(readme, `${command} is missing from README.md`).toContain(
        `npx @brain-db/cli ${command === "connect" ? "" : command}`.trim(),
      );
    }
  });
});
