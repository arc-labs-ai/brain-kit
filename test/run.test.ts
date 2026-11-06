import { describe, expect, it } from "vitest";
import { type RunResult, looksUnsupported, reasonFrom, run } from "../src/clients/run.js";

/**
 * Reading another CLI's answer honestly.
 *
 * Every one of these cases cost a real failure first. The installer reported
 * `Adding marketplace…` as the reason a client could not be configured —
 * which is a spinner frame, printed by a command that had been killed at its
 * deadline and never said anything else.
 */

function result(over: Partial<RunResult> = {}): RunResult {
  return { code: 1, stdout: "", stderr: "", missing: false, timedOut: false, ...over };
}

describe("reading a failed command", () => {
  it("says so when the child was killed at the deadline", () => {
    expect(reasonFrom(result({ timedOut: true, stdout: "Adding marketplace…" }))).toBe(
      "timed out",
    );
  });

  /** The defect this file exists for. */
  it("ignores progress chatter and finds the real line", () => {
    const output = [
      "Adding marketplace…",
      "⠋ cloning",
      "...",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n");
    expect(reasonFrom(result({ stderr: output }))).toBe("and the repository exists.");
  });

  it("falls back to the exit code when there is nothing but chatter", () => {
    expect(reasonFrom(result({ code: 3, stdout: "Working…\n⠹\n" }))).toContain("3");
  });

  it("bounds another tool's output rather than passing it through", () => {
    const reason = reasonFrom(result({ stderr: "x".repeat(500) }));
    expect(reason.length).toBeLessThanOrEqual(200);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("recognises a subcommand this version does not have", () => {
    expect(
      looksUnsupported(result({ stderr: "error: unknown command 'configure'" })),
    ).toBe(true);
    expect(looksUnsupported(result({ stderr: "permission denied" }))).toBe(false);
  });
});

describe("running something that is not there", () => {
  it("reports a missing binary as missing, not as a failure", () => {
    const r = run("definitely-not-a-real-binary-xyz", ["--version"], {
      timeoutMs: 5_000,
    });
    expect(r.missing).toBe(true);
    expect(r.code).toBeUndefined();
    expect(r.timedOut).toBe(false);
  });

  it("reports a real command's success", () => {
    const r = run("node", ["--version"], { timeoutMs: 15_000 });
    expect(r.missing).toBe(false);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^v\d+/);
  });

  /**
   * A child that waits for input would otherwise hold the installer for its
   * whole timeout — which is how a `git clone` of a missing repository behaved
   * before `GIT_TERMINAL_PROMPT=0`.
   */
  it("does not hand a child this process's stdin", () => {
    const r = run(
      "node",
      ["-e", "process.stdin.resume(); setTimeout(()=>process.exit(0), 50)"],
      {
        timeoutMs: 10_000,
      },
    );
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(0);
  });
});
