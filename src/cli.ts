/**
 * Argument parsing and command dispatch.
 *
 * Hand-rolled, and the reason is the same one that keeps this package at zero
 * runtime dependencies: `npx @brain-db/cli` downloads and starts this before it
 * can do anything useful, and an argument parser is a hundred lines of
 * something people are waiting on.
 */

import { knownIds } from "./clients/index.js";
import {
  DEFAULT_BACKEND,
  connect,
  defaultMachineName,
  doctor,
} from "./commands/index.js";
import { say } from "./ui.js";

export type Parsed = {
  command: "connect" | "doctor" | "help" | "version";
  backendUrl: string;
  mcpUrl: string | undefined;
  selfHost: boolean;
  clients: string[];
  dryRun: boolean;
  noBrowser: boolean;
  apiKey: string | undefined;
  namespace: string | undefined;
  machine: string;
};

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * Parse `argv` (without node and the script path).
 *
 * A bare invocation is `connect`, because that is what somebody who just ran
 * `npx @brain-db/cli` wants — being shown a help page instead is a tool making
 * them ask twice.
 */
export function parse(argv: string[]): Parsed {
  const parsed: Parsed = {
    command: "connect",
    backendUrl: process.env.BRAIN_MCP_BACKEND_URL ?? DEFAULT_BACKEND,
    // Unset, not defaulted: an unset value means "use whatever the deployment
    // that issues the key says", which is the behaviour that cannot be wrong.
    mcpUrl: process.env.BRAIN_MCP_URL,
    selfHost: false,
    clients: [],
    dryRun: false,
    noBrowser: false,
    apiKey: process.env.BRAIN_MCP_API_KEY,
    namespace: undefined,
    machine: defaultMachineName(),
  };

  let i = 0;
  // A leading bare word is the command.
  const first = argv[0];
  if (first && !first.startsWith("-")) {
    switch (first) {
      case "connect":
      case "doctor":
      case "help":
        parsed.command = first;
        break;
      default:
        throw new UsageError(`unknown command "${first}"`);
    }
    i = 1;
  }

  for (; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${arg} needs a value`);
      return value;
    };
    switch (arg) {
      case "--backend":
        parsed.backendUrl = next();
        break;
      case "--mcp-url":
        parsed.mcpUrl = next();
        break;
      case "--self-host":
        parsed.selfHost = true;
        break;
      case "--client":
        parsed.clients.push(next());
        break;
      case "--key":
        parsed.apiKey = next();
        break;
      case "--namespace":
        parsed.namespace = next();
        break;
      case "--machine":
        parsed.machine = next();
        break;
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--no-browser":
        parsed.noBrowser = true;
        break;
      case "-h":
      case "--help":
        parsed.command = "help";
        break;
      case "-v":
      case "--version":
        parsed.command = "version";
        break;
      default:
        throw new UsageError(`unknown option "${arg}"`);
    }
  }

  parsed.backendUrl = parsed.backendUrl.replace(/\/+$/, "");
  // Not stripped of a trailing slash: this is a full endpoint path (`…/mcp`),
  // not a base, and trimming it would be trimming someone's route.
  if (parsed.mcpUrl !== undefined && parsed.mcpUrl.trim() === "") {
    parsed.mcpUrl = undefined;
  }
  return parsed;
}

export const USAGE = `
  brain — connect your agents to Brain

  Usage
    npx @brain-db/cli                 set this machine up
    npx @brain-db/cli doctor          check that it actually works

  Options
    --backend <url>      the Brain to connect to
                         (default ${DEFAULT_BACKEND})
    --mcp-url <url>      the MCP endpoint to point clients at
                         (default: whatever the backend hands out)
    --self-host          run the MCP server locally instead of dialling
                         the hosted one — for self-hosting and CI
    --client <id>        configure only this client; repeatable
                         (${knownIds().join(", ")})
    --key <key>          skip the browser and use this key — for CI and
                         headless machines
    --namespace <name>   label the install with this namespace instead of
                         asking the backend which one the key belongs to
    --machine <name>     what to call this machine on the approval screen
    --no-browser         print the URL instead of opening one
    --dry-run            say what would change, write nothing
    -h, --help           this
    -v, --version        print the version
`;

/** Dispatch. Returns a process exit code. */
export async function main(argv: string[], version: string): Promise<number> {
  let parsed: Parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    say();
    say(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
    say(USAGE);
    return 1;
  }

  switch (parsed.command) {
    case "help":
      say(USAGE);
      return 0;
    case "version":
      // The one thing that goes to stdout, because it is a value somebody
      // might capture.
      process.stdout.write(`${version}\n`);
      return 0;
    case "doctor":
      return doctor({
        version,
        backendUrl: parsed.backendUrl,
        mcpUrl: parsed.mcpUrl,
        apiKey: parsed.apiKey,
      });
    case "connect":
      return connect({
        backendUrl: parsed.backendUrl,
        mcpUrl: parsed.mcpUrl,
        selfHost: parsed.selfHost,
        clients: parsed.clients,
        dryRun: parsed.dryRun,
        noBrowser: parsed.noBrowser,
        apiKey: parsed.apiKey,
        namespace: parsed.namespace,
        machine: parsed.machine,
      });
  }
}
