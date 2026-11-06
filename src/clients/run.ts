/**
 * Running another CLI, and reading its answer honestly.
 *
 * Two clients own their own config format (Codex writes TOML, Claude Code
 * keeps plugin state and the keychain), so they are configured by calling
 * their CLI rather than by editing their files. That means this file's job is
 * to tell apart four outcomes that a naive wrapper collapses into "it failed":
 *
 *   · the binary is not installed      → the client is not here; say so
 *   · the binary ran and succeeded     → done
 *   · the binary ran and refused       → report ITS message, not ours
 *   · the binary is too old to know the subcommand → say which, and what to do
 *
 * Collapsing those is how an installer ends up telling someone "Codex failed"
 * when Codex is not installed, or "configured" when it printed usage text and
 * exited non-zero.
 */

import { spawnSync } from "node:child_process";

export type RunResult = {
  /** `undefined` when the binary could not be found at all. */
  code: number | undefined;
  stdout: string;
  stderr: string;
  /** The binary is not on PATH. */
  missing: boolean;
  /** It ran but was killed at the deadline. */
  timedOut: boolean;
};

/** Run `bin` with `args`, capturing output. Never throws. */
export function run(
  bin: string,
  args: string[],
  options?: { timeoutMs?: number; input?: string },
): RunResult {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      // A `git clone` of a repository that does not exist will otherwise sit
      // waiting for a username on a terminal nobody is watching, and the
      // child burns the whole timeout before reporting anything useful.
      GIT_TERMINAL_PROMPT: "0",
      GCM_INTERACTIVE: "never",
    },
    timeout: options?.timeoutMs ?? 60_000,
    input: options?.input,
    // Inherit nothing: a child that inherits this process's stdio can print
    // over our own output, and one that inherits stdin can block forever
    // waiting for input nobody is going to type.
    stdio: ["pipe", "pipe", "pipe"],
  });
  const code = (result.error as NodeJS.ErrnoException | undefined)?.code;
  const missing = result.error !== undefined && code === "ENOENT";
  // `spawnSync` reports a deadline kill as a signal plus an ETIMEDOUT error.
  // Without this a hung child is indistinguishable from one that failed, and
  // `reasonFrom` reports whatever it had printed so far — which for a command
  // that draws progress is a spinner frame, not a reason.
  const timedOut = code === "ETIMEDOUT" || result.signal === "SIGTERM";
  return {
    code: missing ? undefined : (result.status ?? undefined),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    missing,
    timedOut,
  };
}

/** Whether `bin` resolves on PATH at all. */
export function available(bin: string): boolean {
  return !run(bin, ["--version"], { timeoutMs: 15_000 }).missing;
}

/**
 * The most useful line of a failed command's output.
 *
 * Takes the LAST non-empty line, not the first: a CLI that refuses something
 * usually prints context and then the reason, and the first line of a usage
 * dump is "Usage:".
 */
export function reasonFrom(result: RunResult): string {
  if (result.timedOut) return "timed out";
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((l) => l.trim())
    // Progress chatter is not a reason. A command that draws its own spinner
    // leaves lines like "Adding marketplace…" as the last thing it printed,
    // and reporting that as the failure told the reader nothing at all.
    .filter(
      (l) =>
        l.length > 0 &&
        !l.startsWith("Usage:") &&
        !l.endsWith("…") &&
        !l.endsWith("...") &&
        !/^[\s.·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏|/\\-]+$/.test(l),
    );
  const last = lines.at(-1);
  if (!last) return `exited ${result.code ?? "without running"}`;
  // Bounded: another tool's output is not a format we control.
  return last.length > 200 ? `${last.slice(0, 197)}…` : last;
}

/**
 * Whether a failure looks like "this version does not have that subcommand".
 *
 * Worth distinguishing because the fix is "update the client", which is
 * nothing like the fix for any other failure here.
 */
export function looksUnsupported(result: RunResult): boolean {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return (
    text.includes("unknown command") ||
    text.includes("unrecognized subcommand") ||
    text.includes("unexpected argument") ||
    text.includes("unknown option") ||
    text.includes("no such subcommand")
  );
}

/** Parse a `--json` answer, or `undefined` if it was not JSON. */
export function jsonFrom(result: RunResult): unknown {
  for (const candidate of [result.stdout, result.stderr]) {
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    try {
      return JSON.parse(trimmed);
    } catch {
      // Some CLIs print a banner before the JSON. Take the first line that
      // parses on its own.
      for (const line of trimmed.split("\n")) {
        try {
          return JSON.parse(line.trim());
        } catch {
          // keep looking
        }
      }
    }
  }
  return undefined;
}
