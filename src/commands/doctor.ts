/**
 * `brain doctor` — prove the setup actually works.
 *
 * ## Why this command exists
 *
 * Two real bugs shipped in the predecessor to this package, and neither was
 * visible anywhere:
 *
 * 1. The server's entrypoint guard compared `import.meta.url` against
 *    `file://${process.argv[1]}`, which never matches when npm installs the
 *    bin as a **symlink**. So the process started, matched nothing, ran no
 *    server, and exited **0**. Clients reported a closed connection; every
 *    install step had reported success.
 * 2. A user-scoped MCP server **shadows a plugin's server of the same name**.
 *    Installing both left the plugin enabled, its skill loading, its key
 *    unused in the keychain — and the server answering was a different one.
 *
 * What both have in common is that no config file was wrong. Reading the
 * configuration would have told you everything was fine. The only way to find
 * either is to **run the thing and count what comes back**, which is what this
 * does: it spawns the configured server, completes an MCP handshake over
 * stdio, and lists its tools.
 *
 * A setup tool that cannot answer "is it actually working" leaves that
 * question to the agent, which answers it by failing a task later.
 */

import { spawn } from "node:child_process";
import {
  SERVER_NAME,
  SERVER_PACKAGE,
  detect,
  inspect,
  installedSkills,
  readServer,
  skillsDir,
  targets,
} from "../clients/index.js";
import { dim, field, heading, item, nextSteps, problem, say, section } from "../ui.js";

export type DoctorOptions = {
  /**
   * This package's version, reported to the server as the client's.
   *
   * Threaded in rather than hardcoded here. It was hardcoded twice in this
   * file, as "1" and as "0.1.0" — two different answers for one client, and
   * the second silently wrong from the first release that moved past it. A
   * server that logs client versions to decide what to support deserves a
   * true one.
   */
  version: string;
  backendUrl: string | undefined;
  /** Probe this endpoint instead of the one found in a client's config. */
  mcpUrl: string | undefined;
  apiKey: string | undefined;
};

/** Run the checks. Returns a process exit code. */
export async function doctor(options: DoctorOptions): Promise<number> {
  heading(
    "brain doctor",
    "Reads what is configured, then actually calls it. The two are not the same thing.",
  );

  // ── What is configured where ──────────────────────────────────────────────
  section("clients");
  let configuredCount = 0;
  let missingSetup = 0;
  for (const target of targets()) {
    if (!detect(target)) {
      item("skip", target.label, "not installed on this machine");
      continue;
    }
    const state = inspect(target, SERVER_NAME);
    if (state.configured) {
      configuredCount += 1;
      item("ok", target.label, state.where);
    } else {
      missingSetup += 1;
      item("warn", target.label, "installed, but Brain is not set up here");
    }
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  section("skills");
  const skills = installedSkills();
  if (skills.length === 0) {
    item(
      "warn",
      "portable",
      `none in ${skillsDir()} — tools without the knowledge of when to use them`,
    );
  } else {
    item("ok", skills.join(", "), skillsDir());
  }

  // ── The handshake: the only check here that proves anything ───────────────
  section("server");
  const credential = resolveCredential(options);
  if (!credential) {
    item(
      "warn",
      "handshake",
      "no key found to test with — pass --key, or set BRAIN_MCP_API_KEY",
    );
    nextSteps("verdict", [
      "The configuration reads correctly, but nothing was actually run —",
      "which is exactly the gap this command exists to close.",
    ]);
    return configuredCount > 0 ? 0 : 1;
  }

  const probe = await handshake(credential, options.version);
  if (!probe.ok) {
    item("fail", "handshake", `${probe.detail} — ${describe(credential)}`);
    problem(
      credential.kind === "remote"
        ? "The server is configured but does not answer."
        : "The server is configured but does not start.",
      "That is the one failure every other surface reports as success — a config file can look perfect while nothing answers.",
    );
    return 1;
  }
  item(
    "ok",
    "handshake",
    `${probe.server} answered with ${probe.tools} tools — ${describe(credential)}`,
  );

  const steps: string[] = [];
  if (configuredCount === 0) {
    steps.push("No client is set up yet. Run: brain connect");
  } else if (missingSetup > 0) {
    steps.push(
      `Working. ${missingSetup} installed client${missingSetup === 1 ? " is" : "s are"} not set up — run brain connect to add ${missingSetup === 1 ? "it" : "them"}.`,
    );
  } else {
    steps.push("Working. Every client on this machine is set up.");
  }
  if (skills.length === 0) {
    steps.push(dim("No skills installed — run brain connect to add them."));
  }
  nextSteps("verdict", steps);
  return 0;
}

/**
 * What to probe, and how to reach it.
 *
 * A union because the two installs fail in different places and a single
 * "backendUrl" field could not say which was being tested. `remote` dials a
 * hosted endpoint; `local` spawns the stdio package.
 */
type Credential =
  | { kind: "remote"; apiKey: string; url: string }
  | { kind: "local"; apiKey: string; backendUrl: string };

/** Where this probe is pointed, for a one-line report. */
function describe(credential: Credential): string {
  return credential.kind === "remote"
    ? credential.url
    : credential.backendUrl || "the package default";
}

/**
 * A key to test with.
 *
 * Read from a configured client's own config rather than asked for: the point
 * is to test what is installed, and a key typed at the prompt would test a
 * path nothing uses. Claude Code is skipped as a source — its key is in the
 * keychain, which is the whole reason that path is preferred.
 */
function resolveCredential(options: DoctorOptions): Credential | undefined {
  // An explicitly named endpoint wins over anything discovered: that is what
  // somebody passing `--mcp-url` is asking for.
  const named = options.mcpUrl ?? process.env.BRAIN_MCP_URL;
  const key = options.apiKey ?? process.env.BRAIN_MCP_API_KEY;
  if (key && named) return { kind: "remote", apiKey: key, url: named };
  if (key) {
    // A key but no endpoint: fall back to whichever install is configured, so
    // `--key` tests the real one rather than forcing the local path.
    const found = discover();
    if (found?.kind === "remote") {
      return { kind: "remote", apiKey: key, url: found.url };
    }
    return {
      kind: "local",
      apiKey: key,
      backendUrl: options.backendUrl ?? envBackend() ?? "",
    };
  }
  const found = discover();
  if (!found) return undefined;
  if (found.kind === "remote") {
    return named ? { ...found, url: named } : found;
  }
  return options.backendUrl ? { ...found, backendUrl: options.backendUrl } : found;
}

/**
 * The first real install this machine has, read out of a client's own config.
 *
 * Read rather than asked for: the point of this command is to test what is
 * installed, and a key typed at a prompt would exercise a path nothing uses.
 * Claude Code is not a source — its key is in the OS keychain, which is the
 * whole reason that path is preferred — so this finds the JSON clients.
 */
function discover(): Credential | undefined {
  for (const target of targets()) {
    if (target.writer.kind !== "json") continue;
    const entry = readServer(target.writer.path, SERVER_NAME);
    if (!entry) continue;
    if ("url" in entry) {
      const header = entry.headers?.Authorization ?? "";
      const bearer = header.replace(/^Bearer\s+/i, "").trim();
      if (bearer) return { kind: "remote", apiKey: bearer, url: entry.url };
      continue;
    }
    const key = entry.env?.BRAIN_MCP_API_KEY;
    if (key) {
      return {
        kind: "local",
        apiKey: key,
        backendUrl: entry.env?.BRAIN_MCP_BACKEND_URL ?? "",
      };
    }
  }
  return undefined;
}

function envBackend(): string | undefined {
  return process.env.BRAIN_MCP_BACKEND_URL;
}

/** The two requests this probe makes, as ids it can match replies against. */
const REQUEST_INITIALIZE = 1;
const REQUEST_TOOLS = 2;

/**
 * The slice of a JSON-RPC response this probe reads.
 *
 * Narrowed through {@link asResponse} rather than asserted with `as`: the
 * bytes come from another process over a pipe, so a cast here would be a claim
 * about something we have no control over — and the specific failure being
 * tested is a server that writes nothing or writes garbage.
 */
type RpcResponse = {
  readonly id?: number;
  readonly result?: {
    readonly serverInfo?: { readonly name?: string; readonly version?: string };
    readonly tools?: readonly unknown[];
  };
  readonly error?: { readonly message?: string };
};

function asResponse(value: unknown): RpcResponse | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const result =
    typeof raw.result === "object" && raw.result !== null
      ? (raw.result as Record<string, unknown>)
      : undefined;
  const serverInfo =
    result && typeof result.serverInfo === "object" && result.serverInfo !== null
      ? (result.serverInfo as Record<string, unknown>)
      : undefined;
  const error =
    typeof raw.error === "object" && raw.error !== null
      ? (raw.error as Record<string, unknown>)
      : undefined;
  return {
    id: typeof raw.id === "number" ? raw.id : undefined,
    result: result && {
      serverInfo: serverInfo && {
        name: typeof serverInfo.name === "string" ? serverInfo.name : undefined,
        version: typeof serverInfo.version === "string" ? serverInfo.version : undefined,
      },
      tools: Array.isArray(result.tools) ? result.tools : undefined,
    },
    error: error && {
      message: typeof error.message === "string" ? error.message : undefined,
    },
  };
}

type Probe = { ok: true; server: string; tools: number } | { ok: false; detail: string };

/**
 * Spawn the configured MCP server and complete a real handshake.
 *
 * Deliberately speaks JSON-RPC over stdio by hand rather than pulling in the
 * MCP SDK. Three messages is less code than the dependency, and an installer
 * run with `npx` pays for every dependency in cold-start time — but more to
 * the point, the SDK would paper over exactly the failure being tested: it
 * retries, it reframes a dead process as a transport error, and the bug this
 * check exists for is a process that exits 0 and says nothing.
 */
function handshake(credential: Credential, version: string): Promise<Probe> {
  return credential.kind === "remote"
    ? handshakeRemote(credential.url, credential.apiKey, version)
    : handshakeLocal(credential, version);
}

/**
 * Complete a real MCP handshake against a hosted endpoint.
 *
 * Three messages over Streamable HTTP, by hand for the same reason the stdio
 * probe is by hand: the SDK retries and reframes, and the failures worth
 * catching here are the flat ones — a 401 from a revoked key, a 404 from a URL
 * with the path left off, a TLS error, a server that answers but has no tools.
 *
 * Two details the transport requires and a hand-rolled client gets wrong:
 * the response to `initialize` may arrive as `text/event-stream` rather than
 * JSON, and the session id it returns in `Mcp-Session-Id` has to be echoed on
 * every later request or the server rejects them as un-initialised.
 */
async function handshakeRemote(
  url: string,
  apiKey: string,
  version: string,
): Promise<Probe> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 30_000);
  try {
    const post = async (body: unknown, session: string | undefined): Promise<Response> =>
      fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Both, because the server picks: a single-response call may come
          // back as plain JSON, a streaming one as SSE.
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${apiKey}`,
          ...(session ? { "mcp-session-id": session } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

    const init = await post(
      {
        jsonrpc: "2.0",
        id: REQUEST_INITIALIZE,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "brain-doctor", version },
        },
      },
      undefined,
    );
    if (!init.ok) {
      return { ok: false, detail: await httpFailure(init) };
    }
    const session = init.headers.get("mcp-session-id") ?? undefined;
    const initBody = asResponse(await readRpc(init));
    if (initBody?.error) {
      return {
        ok: false,
        detail: `the server refused the handshake: ${initBody.error.message ?? "no reason given"}`,
      };
    }
    const server = initBody?.result?.serverInfo;
    const name = server?.version
      ? `${server.name ?? "the server"} ${server.version}`
      : (server?.name ?? "the server");

    // Required by the spec between `initialize` and any real call. A server
    // that enforces it answers everything else with "not initialized".
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, session);

    const listed = await post(
      { jsonrpc: "2.0", id: REQUEST_TOOLS, method: "tools/list" },
      session,
    );
    if (!listed.ok) {
      return { ok: false, detail: await httpFailure(listed) };
    }
    const toolsBody = asResponse(await readRpc(listed));
    if (toolsBody?.error) {
      return {
        ok: false,
        detail: `the server would not list its tools: ${toolsBody.error.message ?? "no reason given"}`,
      };
    }
    const tools = toolsBody?.result?.tools?.length ?? 0;
    // A handshake that works and exposes nothing is a broken install that
    // every other surface calls connected.
    return tools === 0
      ? { ok: false, detail: `${name} answered but exposes no tools` }
      : { ok: true, server: name, tools };
  } catch (err) {
    if (controller.signal.aborted) {
      return { ok: false, detail: "the server did not answer within 30s" };
    }
    return { ok: false, detail: `could not reach it: ${networkReason(err)}` };
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * Why a `fetch` threw, in terms somebody can act on.
 *
 * Node's `fetch` reports every transport failure as the single word pair
 * "fetch failed" and hangs the real reason off `cause`. Unwrapping it is the
 * difference between "fetch failed" and "nothing is listening" — and the
 * second is the one local failure a developer hits constantly.
 */
function networkReason(err: unknown): string {
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : undefined;
  const code =
    typeof cause === "object" && cause !== null && "code" in cause
      ? String((cause as { code?: unknown }).code)
      : undefined;
  switch (code) {
    case "ECONNREFUSED":
      return "nothing is listening there";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "that host does not resolve";
    case "CERT_HAS_EXPIRED":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
      return `its TLS certificate was rejected (${code})`;
    default:
      break;
  }
  if (cause instanceof Error && cause.message) return cause.message;
  return err instanceof Error ? err.message : String(err);
}

/** A failed HTTP response, said in terms of what to do about it. */
async function httpFailure(response: Response): Promise<string> {
  const body = (await response.text().catch(() => "")).trim().slice(0, 200);
  switch (response.status) {
    case 401:
    case 403:
      return "the key was rejected (401) — it may have been revoked; run brain connect again";
    case 404:
      return "no MCP server at that URL (404) — check the endpoint path";
    default:
      return `the server answered ${response.status}${body ? `: ${body}` : ""}`;
  }
}

/**
 * The JSON-RPC body of a response that may be JSON or an SSE stream.
 *
 * An SSE reply carries the payload on `data:` lines; the last complete one is
 * the response to the request just sent.
 */
async function readRpc(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  }
  let last: unknown;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    try {
      last = JSON.parse(line.slice(5).trim());
    } catch {
      // A keepalive or a partial frame. Not every `data:` line is a message.
    }
  }
  return last;
}

/** Spawn the stdio package and complete a real handshake. */
function handshakeLocal(
  credential: { apiKey: string; backendUrl: string },
  version: string,
): Promise<Probe> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["-y", SERVER_PACKAGE, "--stdio"], {
      env: {
        ...process.env,
        BRAIN_MCP_API_KEY: credential.apiKey,
        ...(credential.backendUrl
          ? { BRAIN_MCP_BACKEND_URL: credential.backendUrl }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (probe: Probe) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.kill("SIGKILL");
      resolve(probe);
    };

    // A cold `npx` may have to download the package. Generous, because the
    // alternative is reporting a slow network as a broken server.
    const deadline = setTimeout(
      () =>
        finish({
          ok: false,
          detail: "the server did not answer within 90s",
        }),
      90_000,
    );

    child.on("error", (err) =>
      finish({ ok: false, detail: `could not start npx: ${err.message}` }),
    );

    // THE check. A server that never starts exits 0 with empty output, which
    // is why this is a failure and not a shrug.
    child.on("exit", (code) =>
      finish({
        ok: false,
        detail:
          stdout.trim() === ""
            ? `the server exited (${code}) without answering${firstLine(stderr)}`
            : `the server closed mid-handshake${firstLine(stderr)}`,
      }),
    );

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let serverName = "unknown";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      for (const message of drainMessages(stdout)) {
        stdout = message.rest;
        const body = asResponse(message.value);
        if (!body) continue;
        if (body.error) {
          finish({
            ok: false,
            detail: body.error.message ?? "the server returned an error",
          });
          return;
        }
        if (body.id === REQUEST_INITIALIZE) {
          const info = body.result?.serverInfo;
          serverName = [info?.name ?? "server", info?.version]
            .filter((part): part is string => Boolean(part))
            .join(" ");
          send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
          send(child, {
            jsonrpc: "2.0",
            id: REQUEST_TOOLS,
            method: "tools/list",
            params: {},
          });
        } else if (body.id === REQUEST_TOOLS) {
          finish({
            ok: true,
            server: serverName,
            tools: body.result?.tools?.length ?? 0,
          });
          return;
        }
      }
    });

    send(child, {
      jsonrpc: "2.0",
      id: REQUEST_INITIALIZE,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "brain-doctor", version },
      },
    });
  });
}

function send(child: ReturnType<typeof spawn>, message: Record<string, unknown>): void {
  child.stdin?.write(`${JSON.stringify(message)}\n`);
}

/** Pull every complete newline-delimited JSON message out of a buffer. */
function drainMessages(buffer: string): Array<{ value: unknown; rest: string }> {
  const out: Array<{ value: unknown; rest: string }> = [];
  let rest = buffer;
  for (;;) {
    const newline = rest.indexOf("\n");
    if (newline === -1) break;
    const line = rest.slice(0, newline).trim();
    rest = rest.slice(newline + 1);
    if (!line) continue;
    try {
      out.push({ value: JSON.parse(line), rest });
    } catch {
      // Not a message. Some wrappers print a banner on stdout; skip it rather
      // than treating it as a protocol fault.
    }
  }
  return out;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim().length > 0);
  return line ? `: ${line.trim().slice(0, 160)}` : "";
}
