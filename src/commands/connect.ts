/**
 * `brain connect` — the whole setup, in one command.
 *
 * ```text
 *   open a session  →  send the human to the browser  →  wait on the stream
 *                   →  collect the credential  →  configure every client
 * ```
 *
 * ## The order is the design
 *
 * Nothing is written until the credential is in hand. A half-configured
 * machine is worse than an unconfigured one: the failure arrives later,
 * somewhere else, as a broken tool inside an agent turn rather than as an
 * error at the moment of setup.
 *
 * ## What the human sees, and why
 *
 * The code is printed **before** the browser opens, and prominently. It is the
 * only thing standing between "someone sent me a link" and "a key to my
 * account is on someone else's laptop", so it has to be visible in the
 * terminal the person is actually looking at, not buried under the URL.
 */

import { hostname, userInfo } from "node:os";
import {
  type ClientTarget,
  type Outcome,
  SERVER_PACKAGE,
  type ServerSpec,
  detect,
  install,
  installSkills,
  knownIds,
  targetById,
  targets,
} from "../clients/index.js";
import {
  ConnectClient,
  ConnectError,
  type ConnectStatus,
  type Grant,
  type Session,
} from "../connect/index.js";
import {
  type Mark,
  callout,
  dim,
  field,
  heading,
  item,
  mask,
  nextSteps,
  openBrowser,
  problem,
  say,
  section,
  waiting,
} from "../ui.js";

/** The backend a plain `brain connect` talks to. */
export const DEFAULT_BACKEND = "https://api.stg.arc-labs.ai";

/** The MCP server name written into every client. */
const SERVER_NAME = "brain";

export type ConnectOptions = {
  backendUrl: string;
  /** Restrict to these client ids. Empty means every detected client. */
  clients: string[];
  dryRun: boolean;
  /** Do not try to open a browser; just print the URL. */
  noBrowser: boolean;
  /** Skip the handoff and use this key. For CI and headless machines. */
  apiKey: string | undefined;
  /** Namespace for a `--key` install, where no browser picked one. */
  namespace: string | undefined;
  machine: string;
};

/** Run the command. Returns a process exit code. */
export async function connect(options: ConnectOptions): Promise<number> {
  heading(
    "brain connect",
    "Give the agents on this machine a memory they keep between sessions.",
  );

  // Argument errors first — before a session is opened, a browser launched or
  // a human asked for anything. A typo in `--client` should not cost a round
  // trip and an approval to discover, and the answer should be about the typo
  // rather than about whatever failed next.
  const chosen = resolveClients(options.clients);
  if (!Array.isArray(chosen)) {
    problem(chosen.what, chosen.remedy);
    return 1;
  }

  // What this run is working with, stated up front. Someone about to authorise
  // something should not have to infer the backend or which clients are in
  // scope from what happens afterwards.
  const explicit = options.clients.length > 0;
  const present = chosen.filter((t) => (explicit ? true : detect(t)));

  say();
  field("backend", options.backendUrl);
  field("machine", options.machine);
  field(
    "clients",
    present.length > 0 ? present.map((t) => t.label).join(", ") : dim("none found"),
  );

  if (present.length === 0) {
    problem(
      "No supported agent client found on this machine.",
      `Install one, or name it anyway: --client ${knownIds().join("|")}`,
    );
    return 1;
  }

  const grant = options.apiKey ? directGrant(options) : await handoff(options, present);
  if (typeof grant === "number") return grant;

  // What arrived. The key is masked rather than hidden entirely: seeing a
  // prefix is how someone matches this against a row in the dashboard's key
  // list later, and it is the proof that a real credential came back.
  section("granted");
  field(
    "namespace",
    grant.space ? `${grant.namespace} / ${grant.space}` : grant.namespace,
  );
  field("key", mask(grant.apiKey));

  const spec: ServerSpec = {
    name: SERVER_NAME,
    command: "npx",
    args: ["-y", SERVER_PACKAGE, "--stdio"],
    env: {
      BRAIN_MCP_BACKEND_URL: grant.backendUrl,
      BRAIN_MCP_API_KEY: grant.apiKey,
    },
  };

  section(options.dryRun ? "would configure" : "configured");
  const outcomes: Outcome[] = present.map((t) => install(t, spec, options.dryRun));
  for (const outcome of outcomes) {
    item(markOf(outcome.status), outcome.client.label, outcome.detail);
  }

  // Skills last, and only when a client that reads them was configured.
  // Dropping files into a shared directory for a machine with nothing to read
  // them is litter.
  if (present.some((t) => t.readsSkills)) {
    for (const skill of installSkills(options.dryRun)) {
      item(
        skill.status === "failed" ? "fail" : skill.status === "skipped" ? "skip" : "ok",
        `skill: ${skill.name}`,
        skill.detail,
      );
    }
  }

  const failed = outcomes.filter((o) => o.status === "failed");
  const configured = outcomes.filter((o) => o.status === "configured");

  if (options.dryRun) {
    nextSteps("dry run", ["Nothing was written. Drop --dry-run to apply the above."]);
    return 0;
  }

  if (configured.length > 0) {
    // The restart is the step people miss, so it is first and it names the
    // clients rather than saying "your clients" — an MCP server is read at
    // start-up, so a configured client that is already running still knows
    // nothing about Brain.
    nextSteps("next", [
      `Restart ${configured.map((o) => o.client.label).join(" and ")}.`,
      "Then ask your agent:",
      dim('  "remember that I prefer pnpm over npm"'),
      dim('  "what do you remember about my tooling?"'),
      "",
      `${dim("Not working?")} brain doctor ${dim("runs the server and tells you why.")}`,
    ]);
  }

  if (failed.length > 0) {
    problem(
      `${failed.length} of ${outcomes.length} clients could not be configured.`,
      configured.length > 0
        ? "The rest are ready — the lines marked ✗ above say what went wrong."
        : "The lines marked ✗ above say what went wrong.",
    );
    return 1;
  }
  return 0;
}

/** An install outcome's mark. */
function markOf(status: Outcome["status"]): Mark {
  switch (status) {
    case "configured":
      return "ok";
    case "skipped":
      return "skip";
    case "failed":
      return "fail";
  }
}

/** A refusal with its own remedy, kept apart from how either is laid out. */
type Refusal = { what: string; remedy: string };

/**
 * Which clients this run should touch, or a refusal naming the mistake.
 *
 * Returns the two halves separately rather than one pre-formatted string. The
 * string version embedded its own indentation, which then collided with the
 * indentation the printer adds — the kind of defect that is invisible in the
 * source and obvious the first time anyone runs it.
 */
function resolveClients(ids: string[]): ClientTarget[] | Refusal {
  if (ids.length === 0) return targets();
  const resolved: ClientTarget[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const target = targetById(id);
    if (target) resolved.push(target);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    return {
      what: `No client called ${unknown.map((u) => `"${u}"`).join(" or ")}.`,
      remedy: `Known clients: ${knownIds().join(", ")}`,
    };
  }
  return resolved;
}

/**
 * The browser handoff.
 *
 * Returns the grant, or an exit code when it could not get one.
 */
async function handoff(
  options: ConnectOptions,
  present: ClientTarget[],
): Promise<Grant | number> {
  const client = new ConnectClient({ backendUrl: options.backendUrl });

  let session: Session;
  try {
    session = await client.begin({
      machine: options.machine,
      clients: present.map((t) => t.id),
    });
  } catch (err) {
    return fail(err);
  }

  // Say what approving will do BEFORE showing the thing that does it. The
  // browser step is the irreversible one, and nobody should arrive at it
  // having to guess what they are agreeing to.
  section("approve");
  say("    Your browser will ask you to confirm the code below. Approving creates");
  say("    an API key in your account and sends it to this machine — nothing is");
  say("    created until you do.");

  // The code gets a box of its own. It is the only defence against a link
  // somebody else sent, and a code set in a paragraph is a code that gets
  // mistyped or skipped.
  callout("Confirm this code in your browser", session.userCode);

  const opened = options.noBrowser ? false : await openBrowser(session.approveUrl);
  if (opened) {
    say(`  ${dim("Opened")} ${session.approveUrl}`);
    say(`  ${dim("If nothing opened, paste that link.")}`);
  } else {
    say(`  ${dim("Open this link:")}`);
    say(`  ${session.approveUrl}`);
  }
  say();

  const spinner = waiting("waiting for you to approve…");
  let status: ConnectStatus;
  try {
    status = await client.watch(session, (next) => {
      // `approving` means a human clicked and the key is being minted. Worth
      // showing: it is the moment the wait changes from "someone needs to
      // act" to "the server is working", and they look identical otherwise.
      if (next === "approving") {
        spinner.stop();
        waiting("approved — creating your key…");
      }
    });
  } catch (err) {
    spinner.stop();
    return fail(err);
  }
  spinner.stop();

  switch (status) {
    case "approved":
      break;
    case "denied":
      problem(
        "Declined in the browser.",
        "No key was created and nothing on this machine was changed.",
      );
      return 1;
    case "expired":
      problem(
        "That request expired before it was approved.",
        "Requests are good for a few minutes. Run connect again.",
      );
      return 1;
    default:
      problem(
        "The request could not be completed.",
        "Nothing was configured. Run connect again.",
      );
      return 1;
  }

  try {
    return await client.claim(session);
  } catch (err) {
    return fail(err);
  }
}

/** A grant assembled from `--key`, for CI and headless machines. */
function directGrant(options: ConnectOptions): Grant | number {
  if (!options.namespace) {
    problem(
      "--key needs --namespace as well.",
      "A key is bound to one namespace, and with no browser in the loop there is nobody to choose it.",
    );
    return 1;
  }
  return {
    apiKey: options.apiKey ?? "",
    namespace: options.namespace,
    space: undefined,
    backendUrl: options.backendUrl,
  };
}

/** Print a failure and return the exit code. */
function fail(err: unknown): number {
  const message = err instanceof Error ? err.message : String(err);
  // The remedy depends on what kind of failure it was, and the typed
  // discriminant is what makes that choosable rather than guessed from wording.
  const remedy =
    err instanceof ConnectError
      ? {
          transport: "Check the address and your connection, then try again.",
          gone: "Run connect again to start a fresh request.",
          unauthorized: "Run connect again to start a fresh request.",
          "already-collected": undefined,
          server: "This is a problem on the server's side. Try again shortly.",
          unsupported: undefined,
          cancelled: undefined,
          malformed: undefined,
        }[err.kind]
      : undefined;
  problem(message, remedy);
  say();
  say(`  ${dim("Nothing on this machine was changed.")}`);
  return 1;
}

/** A name for this machine, for the approval screen and the key's label. */
export function defaultMachineName(): string {
  const host = hostname().replace(/\.local$/, "");
  if (host) return host;
  try {
    return `${userInfo().username}'s machine`;
  } catch {
    return "this machine";
  }
}
