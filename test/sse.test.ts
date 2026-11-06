import { describe, expect, it } from "vitest";
import { SseParser } from "../src/connect/sse.js";

/** Feed a whole payload in one go and collect the events. */
function parse(payload: string) {
  return new SseParser().push(payload);
}

describe("the SSE parser", () => {
  it("reads an event with a name and data", () => {
    expect(parse('event: approved\ndata: {"status":"approved"}\n\n')).toEqual([
      { event: "approved", data: '{"status":"approved"}' },
    ]);
  });

  it("defaults an unnamed event to `message`, as the format says", () => {
    expect(parse("data: hello\n\n")).toEqual([{ event: "message", data: "hello" }]);
  });

  it("joins multiple data lines with a newline", () => {
    expect(parse("data: one\ndata: two\n\n")).toEqual([
      { event: "message", data: "one\ntwo" },
    ]);
  });

  /** Keep-alives arrive as comments and must not look like events. */
  it("ignores comments, which is what a keep-alive is", () => {
    expect(parse(":\n\n: ping\n\n")).toEqual([]);
    expect(parse(":ping\ndata: real\n\n")).toEqual([{ event: "message", data: "real" }]);
  });

  it("accepts all three line terminators", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const payload = `event: denied${eol}data: x${eol}${eol}`;
      expect(parse(payload), `failed for ${JSON.stringify(eol)}`).toEqual([
        { event: "denied", data: "x" },
      ]);
    }
  });

  /**
   * The reason this is a class. A chunk boundary falls wherever the network
   * puts it, and a parser that assumed whole lines would drop events on a
   * slow connection — which is exactly the connection this runs over.
   */
  it("reassembles an event split across arbitrary chunk boundaries", () => {
    const payload = 'event: approved\ndata: {"status":"approved"}\n\n';
    for (let cut = 1; cut < payload.length; cut++) {
      const parser = new SseParser();
      const events = [
        ...parser.push(payload.slice(0, cut)),
        ...parser.push(payload.slice(cut)),
      ];
      expect(events, `split at ${cut}`).toEqual([
        { event: "approved", data: '{"status":"approved"}' },
      ]);
    }
  });

  /** A `\r\n` cut between its two halves is the nastiest boundary. */
  it("handles a chunk boundary inside a CRLF", () => {
    const parser = new SseParser();
    expect(parser.push("data: x\r")).toEqual([]);
    expect(parser.push("\n\r\n")).toEqual([{ event: "message", data: "x" }]);
  });

  it("strips exactly one space after the colon, not all of it", () => {
    expect(parse("data:  two spaces\n\n")).toEqual([
      { event: "message", data: " two spaces" },
    ]);
    expect(parse("data:none\n\n")).toEqual([{ event: "message", data: "none" }]);
  });

  it("does not dispatch an event the stream never finished", () => {
    const parser = new SseParser();
    // No blank line: the event is incomplete and acting on it would mean
    // acting on a status the server did not finish sending.
    expect(parser.push("event: approved\ndata: {")).toEqual([]);
  });

  it("reads several events out of one chunk", () => {
    expect(parse("event: pending\ndata: a\n\nevent: approved\ndata: b\n\n")).toEqual([
      { event: "pending", data: "a" },
      { event: "approved", data: "b" },
    ]);
  });

  it("ignores id and retry rather than treating them as data", () => {
    expect(parse("id: 7\nretry: 1000\nevent: pending\ndata: a\n\n")).toEqual([
      { event: "pending", data: "a" },
    ]);
  });
});
