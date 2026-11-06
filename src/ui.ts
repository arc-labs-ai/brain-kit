/**
 * Terminal output.
 *
 * ## What this file is trying to get right
 *
 * Someone running `npx @brain-db/cli` is about to hand an agent on their
 * laptop the ability to read and write their memories. The output has three
 * jobs, in this order:
 *
 * 1. **Say what is about to happen, before it happens.** Approving in the
 *    browser is the irreversible step; nobody should reach it having to guess
 *    what they are agreeing to.
 * 2. **Make the one thing that matters impossible to miss.** The confirmation
 *    code is the whole defence against a link someone else sent, so it gets a
 *    box of its own rather than a line among many.
 * 3. **Say what changed and what to do next.** A list of ticks is not a
 *    result: a client that was configured still needs restarting, and nobody
 *    knows that unless it is written down.
 *
 * ## Conventions
 *
 * - **Everything goes to stderr.** stdout is reserved so a value a caller
 *   might capture — a version, a future `--json` — is the only thing on it.
 * - **Two-space indent, one aligned label column.** A column of labels is
 *   read down, not across, and alignment is what makes that possible.
 * - **No credential is ever printed.** A key is shown as a masked prefix, so
 *   someone can see one arrived without it landing in their scrollback.
 * - **No colour library.** A handful of escape codes, dropped when the output
 *   is not a terminal — which is the whole of what a dependency would buy a
 *   command that runs for twenty seconds.
 */

const COLOR =
  process.stderr.isTTY === true && !process.env.NO_COLOR && process.env.TERM !== "dumb";

/**
 * Whether box-drawing characters will render.
 *
 * Windows consoles on a non-UTF-8 code page turn them into mojibake, and a
 * mangled box around the one thing the user has to read is worse than no box.
 * Windows Terminal and VS Code both announce themselves.
 */
const UNICODE =
  process.platform !== "win32" ||
  Boolean(process.env.WT_SESSION) ||
  process.env.TERM_PROGRAM === "vscode";

const esc = (code: string) => (COLOR ? `\u001B[${code}m` : "");
const RESET = esc("0");
const BOX = UNICODE
  ? { h: "─", v: "│", tl: "┌", tr: "┐", bl: "└", br: "┘" }
  : { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+" };

/** The label column's width. Every `field` aligns to it. */
const LABEL_WIDTH = 10;

/** The wider column `item` rows align to; long enough for every client name
 *  and for a `skill: <name>` row. */
const ITEM_LABEL_WIDTH = 22;

export function say(line = ""): void {
  process.stderr.write(`${line}\n`);
}

export function dim(text: string): string {
  return `${esc("2")}${text}${RESET}`;
}

export function bold(text: string): string {
  return `${esc("1")}${text}${RESET}`;
}

/** The command's name, at the top. */
export function heading(command: string, summary: string): void {
  say();
  say(`  ${bold(command)}`);
  say(`  ${dim(summary)}`);
}

/** A labelled value in the aligned column. */
export function field(label: string, value: string): void {
  say(`  ${dim(label.padEnd(LABEL_WIDTH))} ${value}`);
}

/** A group title, so a long run of rows is readable. */
export function section(title: string): void {
  say();
  say(`  ${dim(title)}`);
}

/** How a row's outcome is marked. */
export type Mark = "ok" | "skip" | "fail" | "warn";

const MARKS: Record<Mark, string> = UNICODE
  ? { ok: "✓", skip: "–", fail: "✗", warn: "!" }
  : { ok: "+", skip: "-", fail: "x", warn: "!" };

/**
 * One result row: mark, what it was, what happened.
 *
 * The detail is dimmed because the mark and the name are what gets scanned;
 * the path is what gets read once, when something is wrong.
 */
export function item(mark: Mark, label: string, detail: string): void {
  // One space minimum even when the label runs past the column, or a long
  // label butts straight into its detail — which is what "skill: brain-memory"
  // did at eighteen.
  say(`    ${MARKS[mark]} ${label.padEnd(ITEM_LABEL_WIDTH)} ${dim(detail)}`);
}

/**
 * The boxed callout, for the confirmation code.
 *
 * Sized to its content and centred, because this is the one thing on screen
 * that someone has to copy correctly, and a code that reads as part of a
 * paragraph is a code that gets mistyped.
 */
export function callout(title: string, value: string): void {
  const inner = Math.max(title.length, value.length) + 8;
  const line = BOX.h.repeat(inner);
  const centre = (text: string) => {
    const pad = inner - text.length;
    const left = Math.floor(pad / 2);
    return `${" ".repeat(left)}${text}${" ".repeat(pad - left)}`;
  };
  say();
  say(`  ${BOX.tl}${line}${BOX.tr}`);
  say(`  ${BOX.v}${centre(title)}${BOX.v}`);
  say(`  ${BOX.v}${centre("")}${BOX.v}`);
  say(`  ${BOX.v}${bold(centre(value))}${BOX.v}`);
  say(`  ${BOX.v}${centre("")}${BOX.v}`);
  say(`  ${BOX.bl}${line}${BOX.br}`);
  say();
}

/**
 * A closing block of things to do, numbered when there is more than one.
 *
 * Separate from the result rows on purpose: "configured" and "now restart it"
 * are different kinds of statement, and running them together is how the
 * second gets skipped.
 */
export function nextSteps(title: string, steps: string[]): void {
  if (steps.length === 0) return;
  section(title);
  for (const step of steps) say(`    ${step}`);
}

/**
 * A failure, with what to do about it.
 *
 * Takes the remedy as a separate argument so it cannot be forgotten: an error
 * message that says only what broke leaves the reader with nowhere to go, and
 * this is a tool people meet on their first five minutes with the product.
 */
export function problem(what: string, remedy?: string): void {
  say();
  say(`  ${MARKS.fail} ${what}`);
  if (remedy) say(`    ${dim(remedy)}`);
}

/**
 * A credential, shown as proof it arrived rather than as itself.
 *
 * Keeps the prefix, which is the part that identifies which key this is in a
 * dashboard list, and drops everything that makes it usable.
 */
export function mask(secret: string): string {
  const visible = secret.slice(0, 11);
  return `${visible}${UNICODE ? "…" : "..."}${dim(" (not shown)")}`;
}

/**
 * A spinner that degrades to one printed line when stderr is not a terminal.
 *
 * Without the degradation, CI logs and `2>file` fill with thousands of
 * carriage-returned frames. The 80ms interval is the one timer in this file
 * and it decides nothing — see `docs/TIMERS.md`.
 */
export function waiting(label: string): { stop: (final?: string) => void } {
  if (!process.stderr.isTTY) {
    say(`  ${label}`);
    return { stop: (final) => final && say(`  ${final}`) };
  }
  const frames = UNICODE
    ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
    : ["|", "/", "-", "\\"];
  let i = 0;
  const draw = () => {
    process.stderr.write(`\r  ${frames[i % frames.length]} ${label}`);
    i += 1;
  };
  draw();
  const timer = setInterval(draw, 80);
  return {
    stop: (final) => {
      clearInterval(timer);
      // Clear the line before writing over it, or a shorter final message
      // leaves the tail of the longer spinner line behind.
      process.stderr.write("\r\u001B[2K");
      if (final) say(`  ${final}`);
    },
  };
}

/**
 * Open `url` in the default browser, reporting whether the launcher started.
 *
 * Best-effort by design, and the URL is always printed as well: this fails in
 * exactly the environments where it matters most — over SSH, in a container,
 * on a headless box — and a flow that depends on a browser opening is a flow
 * that is broken there.
 */
export async function openBrowser(url: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const [bin, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(bin, args, { stdio: "ignore", detached: true });
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        // Let the launcher outlive this process. Whether the browser then
        // renders the page is not knowable from here and not worth waiting on.
        child.unref();
        resolve(ok);
      };
      // Two events, and between them they answer the only question that CAN
      // be answered: did the launcher start?
      //
      //   `spawn` — Node emits this once the child process exists.
      //   `error` — it does not (no `xdg-open` on a headless box, which is
      //             common and not worth a scary message).
      //
      // No timer. Two earlier versions had one: first a 300ms "no error yet
      // means success", then a 5s "it has not exited so assume it worked".
      // Both were guesses standing in for an event Node already emits, and
      // the first reported success on a machine with no browser at all —
      // suppressing the single line that tells someone to click the link
      // themselves.
      //
      // The exit CODE is deliberately not waited for. `open` and `xdg-open`
      // exit immediately, but a launcher that stays in the foreground while
      // the browser lives would never exit, and waiting for it would hang the
      // install behind a window the user has not closed yet.
      child.once("spawn", () => done(true));
      child.once("error", () => done(false));
    });
  } catch {
    return false;
  }
}
