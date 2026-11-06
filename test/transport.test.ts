/**
 * The transport decision.
 *
 * Brain hosts the MCP server, so a client holds a URL and a key and runs no
 * local process. These tests exist because the first implementation assumed
 * the opposite — it wrote `npx -y @brain-db/mcp --stdio` into every client —
 * and nothing failed loudly: the configs were valid, the installs reported
 * success, and every user paid a cold `npx` to run a build that only their own
 * machine had.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type ClientTarget,
  SERVER_PACKAGE,
  type ServerSpec,
  install,
  readServer,
} from "../src/clients/index.js";
import { DEFAULT_MCP, specFor } from "../src/commands/index.js";
import { parseGrant } from "../src/connect/index.js";
import type { Grant } from "../src/connect/session.js";

const GRANT: Grant = {
  apiKey: "brain_sk_test",
  namespace: "acme",
  space: undefined,
  backendUrl: "https://api.example.test",
  mcpUrl: "https://mcp.example.test/mcp",
};

const OPTIONS = {
  backendUrl: "https://api.example.test",
  mcpUrl: undefined,
  selfHost: false,
  clients: [],
  dryRun: false,
  noBrowser: true,
  apiKey: undefined,
  namespace: undefined,
  machine: "test",
};

describe("specFor", () => {
  it("points clients at the hosted endpoint the grant named", () => {
    const spec = specFor(GRANT, OPTIONS);
    expect(spec.transport).toBe("http");
    if (spec.transport !== "http") throw new Error("unreachable");
    expect(spec.url).toBe("https://mcp.example.test/mcp");
    expect(spec.apiKey).toBe("brain_sk_test");
    // The API base rides along for the plugin's second stored value.
    expect(spec.backendUrl).toBe("https://api.example.test");
  });

  it("obeys the grant over the compiled-in default", () => {
    // The deployment that issued the key is the one that knows where its MCP
    // server lives. Preferring the constant would point a self-hosted user's
    // editors at Arc Labs' staging while reporting success.
    const spec = specFor(GRANT, OPTIONS);
    expect(spec.transport === "http" && spec.url).not.toBe(DEFAULT_MCP);
  });

  it("falls back to the local package when the deployment hosts no server", () => {
    const spec = specFor({ ...GRANT, mcpUrl: undefined }, OPTIONS);
    expect(spec.transport).toBe("stdio");
    if (spec.transport !== "stdio") throw new Error("unreachable");
    expect(spec.args).toContain(SERVER_PACKAGE);
    expect(spec.env.BRAIN_MCP_API_KEY).toBe("brain_sk_test");
  });

  it("runs locally when --self-host asks for it, endpoint or not", () => {
    const spec = specFor(GRANT, { ...OPTIONS, selfHost: true });
    expect(spec.transport).toBe("stdio");
  });

  it("lets --mcp-url override the endpoint the grant named", () => {
    const spec = specFor(GRANT, { ...OPTIONS, mcpUrl: "http://127.0.0.1:8765/mcp" });
    expect(spec.transport === "http" && spec.url).toBe("http://127.0.0.1:8765/mcp");
  });
});

describe("parseGrant", () => {
  it("carries the endpoint off the wire", () => {
    const grant = parseGrant(
      {
        api_key: "k",
        namespace: "n",
        backend_url: "https://api.example.test",
        mcp_url: "https://mcp.example.test/mcp",
      },
      "https://fallback.test",
    );
    expect(grant.mcpUrl).toBe("https://mcp.example.test/mcp");
  });

  it("leaves the endpoint unset rather than inventing one", () => {
    // An absent `mcp_url` is a deployment that hosts no MCP server — a real
    // configuration. Defaulting it here would send a self-hoster's clients to
    // somebody else's server.
    const grant = parseGrant(
      { api_key: "k", namespace: "n", backend_url: "https://api.example.test" },
      "https://fallback.test",
    );
    expect(grant.mcpUrl).toBeUndefined();
  });
});

/** A JSON-config client under a temp path, so a test writes nothing real. */
function jsonTarget(transports: ClientTarget["transports"]): ClientTarget {
  const dir = mkdtempSync(join(tmpdir(), "brain-transport-"));
  return {
    id: "fake",
    label: "Fake",
    writer: { kind: "json", path: join(dir, "mcp.json") },
    evidence: [],
    readsSkills: false,
    transports,
    manual: (spec) =>
      spec.transport === "http" ? `add ${spec.url} by hand` : "add it by hand",
    docs: "",
  };
}

const REMOTE: ServerSpec = {
  transport: "http",
  name: "brain",
  url: "https://mcp.example.test/mcp",
  apiKey: "brain_sk_test",
  backendUrl: "https://api.example.test",
};

describe("writing a remote server into a JSON client", () => {
  it("writes url plus an Authorization header, not a command", () => {
    const target = jsonTarget(["http", "stdio"]);
    const outcome = install(target, REMOTE, false);
    expect(outcome.status).toBe("configured");

    const path = target.writer.kind === "json" ? target.writer.path : "";
    const entry = readServer(path, "brain");
    expect(entry).toBeDefined();
    if (!entry || !("url" in entry)) throw new Error("expected a remote entry");
    expect(entry.url).toBe("https://mcp.example.test/mcp");
    expect(entry.headers.Authorization).toBe("Bearer brain_sk_test");
    // `serverUrl` was the older Windsurf spelling and is not what the current
    // formats read.
    expect(readFileSync(path, "utf8")).not.toContain("serverUrl");
  });

  it("recognises a remote entry as configured", () => {
    // `readServer`'s guard originally required `command`, so a perfectly good
    // remote install read back as "not set up here".
    const target = jsonTarget(["http"]);
    install(target, REMOTE, false);
    const path = target.writer.kind === "json" ? target.writer.path : "";
    expect(readServer(path, "brain")).toBeDefined();
  });

  it("refuses to write a remote server into a client that cannot express one", () => {
    // Claude Desktop's real behaviour: a `url` entry in its config file has
    // been reported to make it rewrite the file and drop every other server.
    // Skipping with an instruction beats corrupting somebody's config.
    const target = jsonTarget(["stdio"]);
    const outcome = install(target, REMOTE, false);
    expect(outcome.status).toBe("skipped");
    expect(outcome.detail).toContain("https://mcp.example.test/mcp");

    const path = target.writer.kind === "json" ? target.writer.path : "";
    expect(readServer(path, "brain")).toBeUndefined();
  });
});
