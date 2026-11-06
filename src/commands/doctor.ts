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
  backendUrl: string | undefined;
  apiKey: string | undefined;
};

/** Run the checks. Returns a process exit code. */
export async function doctor(options: DoctorOptions): Promise<number> {
  heading(
    "brain doctor",
    "Reads what is configured, then runs it. The two are not the same thing.",
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
    const state = inspect(target, "brain");
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

  const probe = await handshake(credential);
  if (!probe.ok) {
    item("fail", "handshake", `${probe.detail} — ${credential.backendUrl}`);
    problem(
      "The server is configured but does not start.",
      "That is the one failure every other surface reports as success — a config file can look perfect while nothing answers.",
    );
    return 1;
  }
  item(
    "ok",
    "handshake",
    `${probe.server} answered with ${probe.tools} tools — ${credential.backendUrl}`,
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

type Credential = { apiKey: string; backendUrl: string };

/**
 * A key to test with.
 *
 * Read from a configured client's own config rather than asked for: the point
 * is to test what is installed, and a key typed at the prompt would test a
 * path nothing uses. Claude Code is skipped as a source — its key is in the
 * keychain, which is the whole reason that path is preferred.
 */
function resolveCredential(options: DoctorOptions): Credential | undefined {
  if (options.apiKey) {
    return {
      apiKey: options.apiKey,
      backendUrl: options.backendUrl ?? envBackend() ?? "",
    };
  }
  const fromEnv = process.env.BRAIN_MCP_API_KEY;
  if (fromEnv) {
    return { apiKey: fromEnv, backendUrl: options.backendUrl ?? envBackend() ?? "" };
  }
  for (const target of targets()) {
    if (target.writer.kind !== "json") continue;
    const entry = readServer(target.writer.path, "brain");
    const key = entry?.env?.BRAIN_MCP_API_KEY;
    if (key) {
      return {
        apiKey: key,
        backendUrl: options.backendUrl ?? entry?.env?.BRAIN_MCP_BACKEND_URL ?? "",
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
function handshake(credential: Credential): Promise<Probe> {
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
        clientInfo: { name: "brain-doctor", version: "0.1.0" },
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
