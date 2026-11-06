import { describe, expect, it, vi } from "vitest";
import {
  ConnectClient,
  ConnectError,
  parseGrant,
  parseSession,
} from "../src/connect/session.js";

const BACKEND = "https://api.example.test";

/**
 * The reconnect wait, replaced.
 *
 * The retry schedule is real behaviour with a real cost; these tests assert
 * how many attempts are made, not how long they take, so they do not spend it.
 */
const noWait = async () => {};

const SESSION_BODY = {
  session_id: "0123456789abcdef0123456789abcdef",
  session_secret: "s3cr3t-value",
  user_code: "WXYZ-2345",
  approve_url: "https://dash.example.test/connect?session=0123",
  expires_at: new Date(Date.now() + 300_000).toISOString(),
  expires_in: 300,
};

const GRANT_BODY = {
  api_key: "brain_live_abc",
  namespace: "acme",
  space: "default",
  backend_url: BACKEND,
};

/** A fetch double driven by a queue of handlers, one per expected call. */
function stubFetch(handlers: Array<(url: string, init: RequestInit) => Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const handler = handlers.shift();
    if (!handler) throw new Error(`unexpected request to ${url}`);
    return handler(url, init ?? {});
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** An SSE response that delivers `frames` and then closes. */
function sse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("parsing a begin response", () => {
  it("accepts a complete one", () => {
    const session = parseSession(SESSION_BODY);
    expect(session.sessionId).toBe(SESSION_BODY.session_id);
    expect(session.secret).toBe(SESSION_BODY.session_secret);
    expect(session.userCode).toBe(SESSION_BODY.user_code);
  });

  /**
   * The point of validating here rather than reading fields loosely: a renamed
   * or missing field has to be an error at the boundary, not an empty string
   * that becomes a client config with no credential in it.
   */
  it("refuses one missing any field it needs", () => {
    for (const field of [
      "session_id",
      "session_secret",
      "user_code",
      "approve_url",
      "expires_at",
    ]) {
      const body: Record<string, unknown> = { ...SESSION_BODY };
      delete body[field];
      expect(() => parseSession(body), `accepted without ${field}`).toThrow(ConnectError);
    }
  });

  it("refuses a blank field as firmly as a missing one", () => {
    expect(() => parseSession({ ...SESSION_BODY, session_secret: "  " })).toThrow(
      ConnectError,
    );
  });

  it("refuses an unreadable expiry", () => {
    expect(() => parseSession({ ...SESSION_BODY, expires_at: "not a date" })).toThrow(
      ConnectError,
    );
  });

  it("refuses a body that is not an object at all", () => {
    for (const body of [null, 42, "text", [], undefined]) {
      expect(() => parseSession(body), `accepted ${JSON.stringify(body)}`).toThrow(
        ConnectError,
      );
    }
  });
});

describe("parsing a claim response", () => {
  it("accepts a complete one", () => {
    const grant = parseGrant(GRANT_BODY, "https://fallback.test");
    expect(grant.apiKey).toBe("brain_live_abc");
    expect(grant.namespace).toBe("acme");
    expect(grant.space).toBe("default");
    expect(grant.backendUrl).toBe(BACKEND);
  });

  it("has no space when the server reported none", () => {
    const grant = parseGrant({ api_key: "k", namespace: "n" }, "https://fallback.test");
    expect(grant.space).toBeUndefined();
  });

  it("falls back to the address we dialled for the backend", () => {
    const grant = parseGrant({ api_key: "k", namespace: "n" }, "https://fallback.test");
    expect(grant.backendUrl).toBe("https://fallback.test");
  });

  /** Configuring a client with no key is the failure this prevents. */
  it("refuses a response with no key", () => {
    expect(() => parseGrant({ namespace: "n" }, BACKEND)).toThrow(ConnectError);
    expect(() => parseGrant({ api_key: "", namespace: "n" }, BACKEND)).toThrow(
      ConnectError,
    );
  });
});

describe("the secret", () => {
  it("travels in a header and never in a URL", async () => {
    const { fetch, calls } = stubFetch([
      () => json(SESSION_BODY),
      () => json(GRANT_BODY),
    ]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    const session = await client.begin({ machine: "laptop", clients: [] });
    await client.claim(session);

    const claim = calls[1];
    expect(claim?.url).not.toContain(SESSION_BODY.session_secret);
    const headers = claim?.init.headers as Record<string, string>;
    expect(headers["x-connect-secret"]).toBe(SESSION_BODY.session_secret);
  });
});

describe("watching a session", () => {
  it("reports each status change and stops at the terminal one", async () => {
    const { fetch } = stubFetch([
      () =>
        sse([
          "event: pending\ndata: {}\n\n",
          "event: approving\ndata: {}\n\n",
          "event: approved\ndata: {}\n\n",
        ]),
    ]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    const seen: string[] = [];
    const status = await client.watch(parseSession(SESSION_BODY), (s) => seen.push(s));
    expect(status).toBe("approved");
    expect(seen).toEqual(["pending", "approving", "approved"]);
  });

  /** A stream that closes before settling is normal; reconnecting is the fix. */
  it("reconnects when the stream closes without settling", async () => {
    const { fetch, calls } = stubFetch([
      () => sse(["event: pending\ndata: {}\n\n"]),
      () => sse(["event: pending\ndata: {}\n\n", "event: denied\ndata: {}\n\n"]),
    ]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    const seen: string[] = [];
    const status = await client.watch(parseSession(SESSION_BODY), (s) => seen.push(s));
    expect(status).toBe("denied");
    expect(calls).toHaveLength(2);
    // `pending` arrived on both streams; the caller is told once. A flaky
    // connection must not redraw the terminal on every retry.
    expect(seen).toEqual(["pending", "denied"]);
  });

  it("reconnects through a transport failure", async () => {
    const { fetch, calls } = stubFetch([
      () => {
        throw new TypeError("fetch failed");
      },
      () => sse(["event: approved\ndata: {}\n\n"]),
    ]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    const status = await client.watch(parseSession(SESSION_BODY), () => {});
    expect(status).toBe("approved");
    expect(calls).toHaveLength(2);
  });

  /**
   * Expiry is the server's verdict, delivered as an event. The client used to
   * decide it from `Date.now()`, which jumps when a laptop wakes.
   */
  it("takes expiry from the server rather than from a local clock", async () => {
    const { fetch } = stubFetch([() => sse(["event: expired\ndata: {}\n\n"])]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    // A session whose wall-clock expiry is already in the past. A local
    // deadline check would short-circuit here and never read the stream.
    const stale = parseSession({
      ...SESSION_BODY,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(await client.watch(stale, () => {})).toBe("expired");
  });

  /**
   * The server cannot distinguish a wrong secret from a session that aged out,
   * so it answers 401 for both. Once a stream has worked, 401 means the record
   * is gone — reporting it as an auth problem would send someone hunting for a
   * fault on their own machine.
   */
  it("reads a 401 after a working stream as expiry, not as a bad secret", async () => {
    const { fetch } = stubFetch([
      () => sse(["event: pending\ndata: {}\n\n"]),
      () => json({ detail: "nope" }, 401),
    ]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    expect(await client.watch(parseSession(SESSION_BODY), () => {})).toBe("expired");
  });

  it("reads a 401 on the very first attempt as a bad secret", async () => {
    const { fetch } = stubFetch([() => json({ detail: "nope" }, 401)]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    await expect(
      client.watch(parseSession(SESSION_BODY), () => {}),
    ).rejects.toMatchObject({ kind: "unauthorized" });
  });

  /**
   * A server that accepts streams and then says nothing is the shape of a
   * broken deployment. The budget is counted in barren ATTEMPTS, not in
   * seconds, so this is abandoned quickly instead of being held for a
   * wall-clock ceiling.
   */
  it("gives up on a server that accepts streams but never reports a status", async () => {
    const { fetch, calls } = stubFetch(
      // More handlers than the budget, so the budget is what stops it.
      Array.from({ length: 40 }, () => () => sse([])),
    );
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    await expect(
      client.watch(parseSession(SESSION_BODY), () => {}),
    ).rejects.toMatchObject({ kind: "server" });
    // Bounded, and nowhere near the handler supply.
    expect(calls.length).toBeLessThan(20);
  });

  /**
   * The other half of counting attempts rather than time: a connection that
   * keeps dropping but keeps reporting is MAKING progress, and must not be
   * cut off. A wall-clock ceiling could not tell these two cases apart.
   */
  it("never gives up on a flaky connection that is still reporting", async () => {
    // Twice the barren budget in reconnects, every one of which reports.
    const handlers = Array.from(
      { length: 30 },
      () => () => sse(["event: pending\ndata: {}\n\n"]),
    );
    handlers.push(() => sse(["event: approved\ndata: {}\n\n"]));
    const { fetch } = stubFetch(handlers);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    expect(await client.watch(parseSession(SESSION_BODY), () => {})).toBe("approved");
  });

  it("stops when cancelled", async () => {
    const { fetch } = stubFetch([() => sse(["event: pending\ndata: {}\n\n"])]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.watch(parseSession(SESSION_BODY), () => {}, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ kind: "cancelled" });
  });
});

describe("failures a caller has to branch on", () => {
  it("classifies each status rather than leaving a message to match on", async () => {
    const cases: Array<[number, string]> = [
      [401, "unauthorized"],
      [404, "gone"],
      [409, "already-collected"],
      [429, "server"],
      [501, "unsupported"],
      [503, "server"],
    ];
    for (const [status, kind] of cases) {
      const { fetch } = stubFetch([() => json({ detail: "x" }, status)]);
      const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
      await expect(
        client.begin({ machine: "laptop", clients: [] }),
        `status ${status}`,
      ).rejects.toMatchObject({ kind });
    }
  });

  /**
   * A double-collect is the one failure here that might mean somebody else
   * holds a key to this account, so the server's own wording is kept.
   */
  it("passes a double-collect's detail through verbatim", async () => {
    const detail =
      "this session's credential has already been collected — if that was not you, revoke the key in the dashboard";
    const { fetch } = stubFetch([() => json(SESSION_BODY), () => json({ detail }, 409)]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    const session = await client.begin({ machine: "laptop", clients: [] });
    await expect(client.claim(session)).rejects.toThrow(/revoke the key/);
  });

  it("names the address it could not reach", async () => {
    const { fetch } = stubFetch([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    const client = new ConnectClient({ backendUrl: BACKEND, fetch, delay: noWait });
    await expect(client.begin({ machine: "laptop", clients: [] })).rejects.toThrow(
      new RegExp(BACKEND),
    );
  });
});
