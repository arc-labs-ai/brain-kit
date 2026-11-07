/**
 * Removal, and the line it must not cross.
 *
 * `disconnect` deletes things out of files that belong to the user. Every test
 * here is about the same question: can it tell what it wrote from what it
 * found? The failure these guard against is not "it left something behind" —
 * that is visible and annoying. It is "it deleted somebody's unrelated server
 * called `brain`", which is invisible and permanent.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ClientTarget,
  SERVER_NAME,
  mergeServer,
  ownsEntry,
  readServer,
  uninstall,
} from "../src/clients/index.js";
import { installSkills, removeSkills, skillsDir } from "../src/clients/skills.js";

const OURS_REMOTE = {
  url: "https://mcp.stg.arc-labs.ai/mcp",
  headers: { Authorization: "Bearer brain_abc123" },
};

const OURS_LOCAL = {
  command: "npx",
  args: ["-y", "@brain-db/mcp", "--stdio"],
  env: { BRAIN_MCP_API_KEY: "brain_abc123" },
};

let dir: string;
let path: string;

/** A JSON-config client pointed at a temp file. */
function target(configPath: string): ClientTarget {
  return {
    id: "test-client",
    label: "Test Client",
    writer: { kind: "json", path: configPath },
    evidence: [],
    readsSkills: true,
    transports: ["http", "stdio"],
    docs: "",
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-disconnect-"));
  path = join(dir, "mcp.json");
});

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("recognising our own entry", () => {
  it("claims a remote server carrying a Brain key", () => {
    expect(ownsEntry(OURS_REMOTE)).toBe(true);
  });

  it("claims a local server running our package", () => {
    expect(ownsEntry(OURS_LOCAL)).toBe(true);
  });

  /**
   * The self-hosting case. Ownership is the key, not the hostname — anything
   * else would refuse to clean up after the people most likely to need it.
   */
  it("claims a remote server on somebody else's host, if the key is ours", () => {
    expect(
      ownsEntry({
        url: "https://brain.internal.example.com/mcp",
        headers: { Authorization: "Bearer brain_selfhosted" },
      }),
    ).toBe(true);
  });

  it("disclaims a remote server whose bearer is not a Brain key", () => {
    expect(
      ownsEntry({
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer sk-not-ours" },
      }),
    ).toBe(false);
  });

  it("disclaims a remote server with no bearer at all", () => {
    expect(ownsEntry({ url: "https://mcp.example.com/mcp", headers: {} })).toBe(false);
  });

  it("disclaims a local server running something else", () => {
    expect(ownsEntry({ command: "node", args: ["their-server.js"], env: {} })).toBe(
      false,
    );
  });
});

describe("removing our server from a config", () => {
  it("takes ours out and leaves everything else untouched", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { theirs: { command: "node", args: ["s.js"] } },
        editorPreference: "do not touch",
      }),
    );
    mergeServer(path, SERVER_NAME, OURS_REMOTE);

    const removal = uninstall(target(path), false);
    expect(removal.status).toBe("removed");
    expect(readServer(path, SERVER_NAME)).toBeUndefined();
    expect(readServer(path, "theirs")).toBeTruthy();
    expect(read().editorPreference).toBe("do not touch");
  });

  /** THE test. A server under our name that we did not write stays put. */
  it("refuses to delete somebody else's server of the same name", () => {
    const theirs = { url: "https://brain.example.com/mcp", headers: {} };
    mergeServer(path, SERVER_NAME, theirs);

    const removal = uninstall(target(path), false);
    expect(removal.status).toBe("kept");
    expect(removal.detail).toContain("not one of ours");
    expect(readServer(path, SERVER_NAME)).toEqual(theirs);
  });

  it("reports an absent entry as absent rather than as a failure", () => {
    const removal = uninstall(target(path), false);
    expect(removal.status).toBe("absent");
  });

  it("reports a config file that does not exist as absent", () => {
    const removal = uninstall(target(join(dir, "nowhere", "mcp.json")), false);
    expect(removal.status).toBe("absent");
  });

  it("writes nothing on a dry run", () => {
    mergeServer(path, SERVER_NAME, OURS_REMOTE);
    const before = readFileSync(path, "utf8");

    const removal = uninstall(target(path), true);
    expect(removal.status).toBe("would");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(readServer(path, SERVER_NAME)).toEqual(OURS_REMOTE);
  });

  /**
   * An unparseable config is refused on the way out for the same reason it is
   * refused on the way in: a trailing comma in someone's file is not
   * permission to rewrite it.
   */
  it("leaves an unparseable config alone instead of rewriting it", () => {
    writeFileSync(path, "{{{ not json");
    const removal = uninstall(target(path), false);
    expect(removal.status).toBe("absent");
    expect(readFileSync(path, "utf8")).toBe("{{{ not json");
  });
});

describe("removing the shared skills", () => {
  /**
   * `~/.agents/skills` is shared with every other agent tool on the machine,
   * so these run against a temp HOME. Without that, a test run would delete
   * the developer's own skills — which is precisely the class of mistake the
   * marker file exists to prevent.
   */
  let home: string;
  const realHome = process.env.HOME;
  const realProfile = process.env.USERPROFILE;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "brain-home-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });

  // Put it back. A worker that outlives this file with HOME pointed at a
  // deleted temp directory is a confusing failure in somebody else's test.
  afterEach(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realProfile;
  });

  it("removes the ones it installed", () => {
    const installed = installSkills(false);
    expect(installed.length).toBeGreaterThan(0);
    expect(installed.every((s) => s.status === "installed")).toBe(true);

    const removed = removeSkills(false);
    expect(removed.length).toBe(installed.length);
    expect(removed.every((s) => s.status === "removed")).toBe(true);
    for (const skill of removed) {
      expect(existsSync(join(skillsDir(), skill.name))).toBe(false);
    }
  });

  it("leaves a skill it did not install, even under one of our names", () => {
    const installed = installSkills(false);
    const name = installed[0]?.name;
    if (name === undefined) throw new Error("no bundled skills to test with");

    // Theirs: same name, no marker file.
    const mine = join(skillsDir(), name);
    removeSkills(false);
    mkdirSync(mine, { recursive: true });
    writeFileSync(join(mine, "SKILL.md"), "---\nname: mine\n---\n");

    expect(removeSkills(false)).toEqual([]);
    expect(existsSync(join(mine, "SKILL.md"))).toBe(true);
  });

  it("deletes nothing on a dry run", () => {
    installSkills(false);
    const planned = removeSkills(true);
    expect(planned.length).toBeGreaterThan(0);
    expect(planned.every((s) => s.status === "skipped")).toBe(true);
    for (const skill of planned) {
      expect(existsSync(join(skillsDir(), skill.name))).toBe(true);
    }
  });

  it("reports nothing on a machine with no skills directory", () => {
    expect(removeSkills(false)).toEqual([]);
  });
});
