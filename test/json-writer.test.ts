import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  WriteError,
  mergeServer,
  readServer,
  removeServer,
} from "../src/clients/json.js";

const ENTRY = {
  command: "npx",
  args: ["-y", "@brain-db/mcp", "--stdio"],
  env: { BRAIN_MCP_API_KEY: "brain_secret", BRAIN_MCP_BACKEND_URL: "https://x" },
};

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "brain-json-"));
  path = join(dir, "mcp.json");
});

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("writing into a config that does not exist yet", () => {
  it("creates it with the server in place", () => {
    const result = mergeServer(path, "brain", ENTRY);
    expect(result.replaced).toBe(false);
    expect(result.backup).toBeUndefined();
    expect(read()).toEqual({ mcpServers: { brain: ENTRY } });
  });

  /** It now holds an API key. */
  it("creates it readable only by its owner", () => {
    mergeServer(path, "brain", ENTRY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("writing into someone's existing config", () => {
  it("keeps their other servers and their unrelated settings", () => {
    writeFileSync(
      path,
      JSON.stringify({
        mcpServers: { theirs: { command: "node", args: ["s.js"] } },
        editorPreference: "do not touch",
      }),
    );
    mergeServer(path, "brain", ENTRY);

    const after = read();
    const servers = after.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).sort()).toEqual(["brain", "theirs"]);
    expect(after.editorPreference).toBe("do not touch");
  });

  it("reports replacing an entry it already had", () => {
    mergeServer(path, "brain", ENTRY);
    const second = mergeServer(path, "brain", {
      ...ENTRY,
      env: { ...ENTRY.env, BRAIN_MCP_BACKEND_URL: "https://changed" },
    });
    expect(second.replaced).toBe(true);
    expect(readServer(path, "brain")?.env.BRAIN_MCP_BACKEND_URL).toBe("https://changed");
  });

  it("backs it up before the first change", () => {
    const original = JSON.stringify({ mcpServers: {}, keep: 1 });
    writeFileSync(path, original);
    const result = mergeServer(path, "brain", ENTRY);
    expect(result.backup).toBe(`${path}.brain-backup`);
    expect(readFileSync(`${path}.brain-backup`, "utf8")).toBe(original);
  });

  /**
   * The FIRST backup, not the latest. The useful one is from before this tool
   * ever touched the file — overwriting it on a second run would replace the
   * user's original with our own earlier output, which is exactly when
   * somebody reaches for a backup.
   */
  it("does not overwrite the backup on a later run", () => {
    const original = JSON.stringify({ mcpServers: {}, theirs: "original" });
    writeFileSync(path, original);
    mergeServer(path, "brain", ENTRY);
    mergeServer(path, "brain", ENTRY);
    expect(readFileSync(`${path}.brain-backup`, "utf8")).toBe(original);
  });

  it("locks down a file that was world-readable", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: {} }));
    chmodSync(path, 0o644);
    mergeServer(path, "brain", ENTRY);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("a config this tool must not touch", () => {
  /**
   * The most consequential behaviour in this file. A trailing comma in
   * somebody's config is not permission to delete the rest of it.
   */
  it("refuses unparseable JSON and leaves the bytes alone", () => {
    const broken = '{ "mcpServers": { "keep": {} },, }';
    writeFileSync(path, broken);
    expect(() => mergeServer(path, "brain", ENTRY)).toThrow(WriteError);
    expect(readFileSync(path, "utf8")).toBe(broken);
    expect(existsSync(`${path}.brain-backup`)).toBe(false);
  });

  it("refuses a JSON file that is not an object", () => {
    for (const contents of ["[1,2,3]", '"a string"', "42", "null"]) {
      writeFileSync(path, contents);
      expect(() => mergeServer(path, "brain", ENTRY), `accepted ${contents}`).toThrow(
        WriteError,
      );
      expect(readFileSync(path, "utf8")).toBe(contents);
    }
  });

  /** An app can create its config and never write to it. */
  it("treats an empty file as an empty config rather than corruption", () => {
    for (const contents of ["", "   \n\t "]) {
      writeFileSync(path, contents);
      expect(() => mergeServer(path, "brain", ENTRY)).not.toThrow();
      expect(readServer(path, "brain")).toBeTruthy();
    }
  });

  it("survives an mcpServers that is the wrong type", () => {
    writeFileSync(path, JSON.stringify({ mcpServers: "not an object" }));
    expect(() => mergeServer(path, "brain", ENTRY)).not.toThrow();
    expect(readServer(path, "brain")).toBeTruthy();
  });
});

describe("reading back and removing", () => {
  it("finds the entry it wrote", () => {
    mergeServer(path, "brain", ENTRY);
    expect(readServer(path, "brain")).toEqual(ENTRY);
  });

  it("reports nothing for a file or entry that is not there", () => {
    expect(readServer(path, "brain")).toBeUndefined();
    mergeServer(path, "brain", ENTRY);
    expect(readServer(path, "other")).toBeUndefined();
  });

  /** Inspecting is not writing: a broken file is reported as "no entry". */
  it("does not throw while inspecting an unparseable file", () => {
    writeFileSync(path, "{{{");
    expect(readServer(path, "brain")).toBeUndefined();
  });

  it("removes only the named entry", () => {
    mergeServer(path, "brain", ENTRY);
    mergeServer(path, "theirs", { command: "node", args: [], env: {} });
    expect(removeServer(path, "brain")).toBe(true);
    expect(readServer(path, "brain")).toBeUndefined();
    expect(readServer(path, "theirs")).toBeTruthy();
  });

  it("reports nothing removed when there was nothing to remove", () => {
    expect(removeServer(path, "brain")).toBe(false);
    mergeServer(path, "theirs", { command: "node", args: [], env: {} });
    expect(removeServer(path, "brain")).toBe(false);
  });
});
