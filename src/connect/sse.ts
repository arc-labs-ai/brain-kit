/**
 * A minimal Server-Sent Events reader over `fetch`.
 *
 * Node has no `EventSource`, and the one in a browser cannot send headers —
 * which rules it out here, because the session secret must travel in a header
 * and never in a URL. So this parses the wire format directly.
 *
 * Only what the format actually requires, per the WHATWG spec:
 *
 * - events are separated by a blank line;
 * - a line is `field: value`, with one optional space after the colon;
 * - a line starting with `:` is a comment, which is also what a keep-alive is;
 * - `\r\n`, `\n` and a bare `\r` are all line terminators;
 * - multiple `data:` lines in one event join with `\n`.
 *
 * Deliberately not a dependency. This file is about eighty lines, and an
 * installer people run with `npx` pays for every dependency in cold-start
 * latency before it has done anything at all.
 */

/** One parsed event. */
export type ServerEvent = {
  /** The `event:` field, or `"message"` when absent — the spec's default. */
  event: string;
  /** The joined `data:` lines. */
  data: string;
};

/**
 * Incremental SSE parser.
 *
 * Fed arbitrary chunks, which is the whole reason this is a class: a chunk
 * boundary can fall anywhere, including mid-line and between the `\r` and the
 * `\n` of one terminator, so the leftovers have to live somewhere between
 * calls.
 */
export class SseParser {
  private buffer = "";
  private dataLines: string[] = [];
  private eventName: string | undefined;

  /** Feed a chunk; returns every event it completed. */
  push(chunk: string): ServerEvent[] {
    this.buffer += chunk;
    const out: ServerEvent[] = [];

    // Split on any of the three terminators, keeping the last (possibly
    // partial) line in the buffer.
    const lines = this.buffer.split(/\r\n|\n|\r/);
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (line === "") {
        const event = this.flush();
        if (event) out.push(event);
        continue;
      }
      // A comment. Keep-alives arrive as `:` lines and must not dispatch.
      if (line.startsWith(":")) continue;

      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      // One optional leading space after the colon is part of the framing,
      // not of the value.
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "event") this.eventName = value;
      else if (field === "data") this.dataLines.push(value);
      // `id` and `retry` are accepted and ignored: this client reconnects on
      // its own terms and replays nothing.
    }
    return out;
  }

  /** Complete the pending event, if there is one. */
  private flush(): ServerEvent | undefined {
    if (this.dataLines.length === 0 && this.eventName === undefined) {
      return undefined;
    }
    const event: ServerEvent = {
      event: this.eventName ?? "message",
      data: this.dataLines.join("\n"),
    };
    this.dataLines = [];
    this.eventName = undefined;
    return event;
  }
}

/**
 * Read `response` as an event stream, yielding each event.
 *
 * Ends when the server closes the stream. A truncated final event is dropped
 * rather than dispatched: a half-received event is not an event, and guessing
 * at one is how a client acts on a status the server never finished sending.
 */
export async function* readEvents(response: Response): AsyncGenerator<ServerEvent> {
  const body = response.body;
  if (!body) return;
  const decoder = new TextDecoder();
  const parser = new SseParser();
  // `as` because Node types the web stream as a generic ReadableStream, which
  // is async-iterable at runtime on every version this package supports.
  const stream = body as unknown as AsyncIterable<Uint8Array>;
  for await (const chunk of stream) {
    for (const event of parser.push(decoder.decode(chunk, { stream: true }))) {
      yield event;
    }
  }
}
