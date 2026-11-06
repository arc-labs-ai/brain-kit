/**
 * The client half of the `connect` handoff.
 *
 * ```text
 *   begin   POST /v1/connect/sessions          → id, secret, code, approve_url
 *   watch   GET  …/{id}/stream   (SSE)         → pending … approved | denied | …
 *   claim   POST …/{id}/claim                  → the credential, once
 * ```
 *
 * The secret always travels in a header, never in a URL: a URL lands in access
 * logs, proxy logs and shell history, and the secret is what guards the key.
 *
 * ## What this file is mostly about
 *
 * Not the happy path — that is three requests. It is about the ways a laptop
 * fails mid-handoff. The stream will drop: wifi flaps, a lid closes, a VPN
 * reconnects. So `watch` reconnects, and reconnecting is safe because the
 * server reports the session's *current* state at the top of every stream
 * rather than only announcing transitions. A client that slept through the
 * approval is told about it the moment it comes back.
 */

import { readEvents } from "./sse.js";

/** How far a handoff has got. */
export type ConnectStatus =
  | "pending"
  | "approving"
  | "approved"
  /** Approved, and the credential has been collected. Terminal. */
  | "collected"
  | "denied"
  | "failed"
  | "expired";

/** A session, as `begin` reports it. */
export type Session = {
  sessionId: string;
  /** Header credential. Never logged, never put in a URL. */
  secret: string;
  /** The code to show the human; they type it in the browser. */
  userCode: string;
  approveUrl: string;
  expiresAt: Date;
};

/** Everything needed to configure a client. */
export type Grant = {
  apiKey: string;
  namespace: string;
  space: string | undefined;
  backendUrl: string;
  /**
   * The hosted MCP endpoint, when the issuing deployment runs one.
   *
   * `undefined` means it does not, and the install falls back to running the
   * stdio package locally. There is deliberately NO default here: a guessed
   * endpoint would point this machine's editors at somebody else's
   * deployment, and would do it while reporting success.
   */
  mcpUrl: string | undefined;
};

/**
 * What kind of failure this is.
 *
 * A discriminant rather than a message test. The caller has to branch — a
 * transport blip is retried, a gone session is not — and branching on
 * `err.message.includes(...)` is a branch that breaks the next time someone
 * improves the wording.
 */
export type ConnectErrorKind =
  /** Could not reach the server at all. Retry. */
  | "transport"
  /** The session no longer exists: settled, declined or aged out. */
  | "gone"
  /** The secret is not this session's. */
  | "unauthorized"
  /** A credential for this session was already collected by somebody. */
  | "already-collected"
  /** The server refused for its own reasons. Retry. */
  | "server"
  /** This deployment does not offer the browser handoff. */
  | "unsupported"
  /** The caller cancelled. */
  | "cancelled"
  /** The server answered, but not with something usable. */
  | "malformed";

/** A failure with a message already written for a terminal. */
export class ConnectError extends Error {
  readonly kind: ConnectErrorKind;

  constructor(kind: ConnectErrorKind, message: string) {
    super(message);
    this.name = "ConnectError";
    this.kind = kind;
  }

  /** Whether re-running the same request could plausibly work. */
  get retryable(): boolean {
    return this.kind === "transport" || this.kind === "server";
  }
}

/** The secret's header. Matches the gateway's `SECRET_HEADER`. */
const SECRET_HEADER = "x-connect-secret";

/** How long to wait between stream reconnects, and the ceiling. */
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 5_000;

/**
 * How many reconnects in a row may fail to produce anything before `watch`
 * gives up.
 *
 * **Counted in events, not in seconds.** The first version of this was an
 * hour of wall-clock — and a wall-clock ceiling is wrong in both directions
 * for the same reason the expiry check was: it fires on a clock that jumps,
 * and it says nothing about whether progress is being made. A CLI on a train
 * with intermittent signal makes progress and would be cut off; one talking
 * to a broken deployment makes none and would be held for the full hour.
 *
 * This counts what actually matters: consecutive attempts that produced no
 * status at all. Any status resets it, so a flaky connection that keeps
 * reconnecting successfully is never cut off, and a server that accepts
 * streams and says nothing is abandoned in seconds rather than in an hour.
 *
 * Six, because the backoff schedule below turns each attempt into real
 * waiting: six barren attempts is about seventeen seconds before giving up,
 * which is long enough to ride out a reconnect and short enough that nobody
 * is left watching a spinner wondering.
 */
const MAX_BARREN_ATTEMPTS = 6;

/**
 * How often the server sends an SSE keep-alive comment.
 *
 * Not a knob — it is axum's `KeepAlive::default()` on the gateway's stream
 * route, and the number below is derived from it rather than guessed. If that
 * ever changes, this is the one place that has to follow.
 */
const SERVER_KEEPALIVE_MS = 15_000;

/**
 * How long one stream attempt may produce nothing at all before it is
 * abandoned and retried.
 *
 * Three missed keep-alives, which is the smallest number that cannot be
 * tripped by one late packet.
 *
 * This is a **watchdog**, which is the one job a timer is the right tool for:
 * there is no event for "the network went away". The server sends SSE
 * keep-alive comments, so silence is itself the signal — this long without one
 * means the connection is dead in a way TCP has not noticed, the classic
 * laptop-changed-networks case where a socket stays "open" forever against an
 * address that no longer routes.
 *
 * It decides nothing about the session. It only ends one attempt so the next
 * can start, which is why its expiry is a reconnect rather than a verdict.
 */
const STREAM_SILENCE_MS = 3 * SERVER_KEEPALIVE_MS;

export type ConnectClientOptions = {
  backendUrl: string;
  /** Overridable for tests; defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /**
   * How the client waits between reconnects. Overridable for tests.
   *
   * A seam rather than a fake clock: the retry schedule is real behaviour with
   * a real cost — six barren attempts is about seventeen seconds of someone's
   * time — and a test that asserts the *number* of attempts should not also
   * have to spend that. Replacing the wait is the smallest honest way to do
   * that, and it leaves the schedule itself exercised in production only.
   */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** The handoff client. */
export class ConnectClient {
  private readonly base: string;
  private readonly http: typeof globalThis.fetch;
  private readonly delay: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: ConnectClientOptions) {
    this.base = options.backendUrl.replace(/\/+$/, "");
    this.http = options.fetch ?? globalThis.fetch;
    this.delay = options.delay ?? sleep;
  }

  /** Open a session for this machine. */
  async begin(input: {
    machine: string;
    clients: string[];
  }): Promise<Session> {
    const response = await this.send("POST", "/v1/connect/sessions", {
      body: input,
    });
    return parseSession(await this.json(response));
  }

  /**
   * Watch a session until it settles, calling `onStatus` for each change.
   *
   * ## Expiry is the server's call, not a local timer
   *
   * An earlier version of this loop ran `while (Date.now() < expiresAt)` and
   * returned `"expired"` on its own. That is a worse answer in both
   * directions. The wall clock moves — NTP corrects it, and a laptop resuming
   * from sleep jumps it forward, which is exactly when a handoff is likely to
   * be mid-flight — so the local verdict could fire minutes early. And the two
   * clocks could simply disagree, leaving the CLI saying "expired" about a
   * session the server was still happy to approve.
   *
   * There is no need to guess, because the server **emits** expiry: its own
   * watcher reports `expired` when the deadline passes and closes the stream.
   * So this loop waits for an event and the only clock it reads is a monotonic
   * one, for a resource ceiling that is never reached in practice.
   *
   * Reconnecting is safe and expected — laptops sleep, wifi flaps — because
   * the server reports the session's *current* state at the top of every
   * stream rather than only announcing transitions. A client that slept
   * through the approval is told about it the moment it comes back.
   */
  async watch(
    session: Session,
    onStatus: (status: ConnectStatus) => void,
    options?: { signal?: AbortSignal },
  ): Promise<ConnectStatus> {
    let backoff = RECONNECT_BASE_MS;
    let last: ConnectStatus | undefined;
    let everConnected = false;
    let barren = 0;

    for (;;) {
      if (options?.signal?.aborted) throw abortError();
      let sawStatus = false;
      try {
        const settled = await this.streamOnce(
          session,
          (status) => {
            everConnected = true;
            sawStatus = true;
            // Reconnecting re-reports the current state, so the same status
            // arrives again on every reconnect. Only changes are surfaced, or
            // a flaky connection would redraw the terminal on every retry.
            if (status === last) return;
            last = status;
            onStatus(status);
          },
          options?.signal,
        );
        if (settled) return settled;
        // The stream ended without a terminal status: the server closed it, or
        // it went silent. Reconnect at the base delay — this is not a failure.
        backoff = RECONNECT_BASE_MS;
      } catch (err) {
        if (isAbort(err)) throw abortError();
        if (err instanceof ConnectError) {
          // A `401` once the stream has worked at least once does not mean the
          // secret is wrong — it means the session record is no longer there,
          // which is what an aged-out session looks like from here. Reporting
          // it as an auth failure would send someone looking for a problem
          // with their machine.
          if (err.kind === "unauthorized" && everConnected) return "expired";
          if (err.kind === "gone") return "expired";
          if (!err.retryable) throw err;
        }
        // A transport failure. Back off and try again — the session is still
        // open on the server and the human may be mid-approval.
      }

      // Progress resets the budget; only a run of attempts that learned
      // nothing counts against it.
      barren = sawStatus ? 0 : barren + 1;
      if (barren >= MAX_BARREN_ATTEMPTS) {
        throw new ConnectError(
          "server",
          `Could not get a status from ${this.base} after ${MAX_BARREN_ATTEMPTS} attempts. Nothing was configured.`,
        );
      }

      await this.delay(Math.min(backoff, RECONNECT_MAX_MS), options?.signal);
      backoff *= 2;
    }
  }

  /**
   * One stream attempt. Resolves with the terminal status, or `undefined` if
   * the stream ended without one.
   */
  private async streamOnce(
    session: Session,
    onStatus: (status: ConnectStatus) => void,
    signal?: AbortSignal,
  ): Promise<ConnectStatus | undefined> {
    // Its own controller so the silence watchdog can cut this attempt without
    // cancelling the caller's whole operation.
    const attempt = new AbortController();
    const onOuterAbort = () => attempt.abort();
    signal?.addEventListener("abort", onOuterAbort, { once: true });

    // Whether it was OUR watchdog that aborted, rather than the caller.
    //
    // This flag is the whole fix for a bug that defeated the reconnect design:
    // both aborts surface as the same `AbortError`, so without it a silent
    // connection — a laptop changing networks, the exact case the watchdog
    // exists for — was indistinguishable from the user pressing ctrl-C, and
    // `watch` gave up with "Cancelled." instead of reconnecting.
    let silenced = false;

    let silence: ReturnType<typeof setTimeout> | undefined;
    const resetSilence = () => {
      if (silence) clearTimeout(silence);
      silence = setTimeout(() => {
        silenced = true;
        attempt.abort();
      }, STREAM_SILENCE_MS);
    };

    try {
      const response = await this.send(
        "GET",
        `/v1/connect/sessions/${session.sessionId}/stream`,
        {
          secret: session.secret,
          signal: attempt.signal,
          accept: "text/event-stream",
        },
      );
      resetSilence();
      for await (const event of readEvents(response)) {
        resetSilence();
        const status = asStatus(event.event) ?? asStatus(readStatus(event.data));
        if (!status) continue;
        onStatus(status);
        if (isTerminal(status)) return status;
      }
      return undefined;
    } catch (err) {
      // Our own watchdog, and the caller has not cancelled: the connection
      // went quiet. That is a dropped stream, which is a reconnect — reported
      // the same way a server-closed stream is.
      if (silenced && isAbort(err) && signal?.aborted !== true) {
        return undefined;
      }
      throw err;
    } finally {
      if (silence) clearTimeout(silence);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }

  /**
   * Collect the credential. Exactly once per session, server-side.
   *
   * Separate from the stream on purpose: a stream write is fire-and-forget, so
   * a credential delivered that way would be lost AND consumed if the socket
   * broke mid-write. This is a request with a status code, so a transport
   * failure is a retry rather than a burned session.
   */
  async claim(session: Session): Promise<Grant> {
    const response = await this.send(
      "POST",
      `/v1/connect/sessions/${session.sessionId}/claim`,
      { secret: session.secret },
    );
    return parseGrant(await this.json(response), this.base);
  }

  /** One request, with this client's conventions applied. */
  private async send(
    method: string,
    path: string,
    init?: {
      body?: unknown;
      secret?: string;
      signal?: AbortSignal;
      accept?: string;
    },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: init?.accept ?? "application/json",
    };
    if (init?.body !== undefined) headers["content-type"] = "application/json";
    // In a header, never the URL.
    if (init?.secret) headers[SECRET_HEADER] = init.secret;

    let response: Response;
    try {
      response = await this.http(`${this.base}${path}`, {
        method,
        headers,
        body: init?.body === undefined ? undefined : JSON.stringify(init.body),
        signal: init?.signal,
      });
    } catch (err) {
      if (isAbort(err)) throw err;
      // Names the address and stops. The advice belongs to whoever is
      // printing this — a message that carries its own remedy ends up saying
      // it twice when the caller adds one.
      throw new ConnectError("transport", `Could not reach ${this.base}.`);
    }
    if (!response.ok) throw await this.failure(response);
    return response;
  }

  /** Turn a non-2xx into a typed failure with a message worth printing. */
  private async failure(response: Response): Promise<ConnectError> {
    const detail = await problemDetail(response);
    switch (response.status) {
      case 401:
        // The server cannot tell a wrong secret from a session that no longer
        // exists, and deliberately does not try — distinguishing them would
        // let anyone discover which session ids are real. The caller resolves
        // it from context: before the first successful read it means the
        // secret, after one it means the session is gone.
        return new ConnectError(
          "unauthorized",
          "This machine is not the one that opened the request. Run connect again to start a new one.",
        );
      case 404:
        return new ConnectError(
          "gone",
          "That request no longer exists — it was declined, or it expired. Run connect again.",
        );
      case 409:
        // The gateway uses 409 for a double-collect, and its detail says what
        // to do about it. Surfaced verbatim: it is the one error here that
        // might mean somebody else has a key to this account.
        return new ConnectError(
          "already-collected",
          detail ?? "That request has already been settled.",
        );
      case 429:
        return new ConnectError(
          "server",
          "Too many connect requests from this address. Wait a few minutes and try again.",
        );
      case 501:
        return new ConnectError(
          "unsupported",
          `${this.base} does not support browser setup. Pass --key with a key from the dashboard instead.`,
        );
      default:
        return new ConnectError(
          response.status >= 500 ? "server" : "gone",
          detail ?? `The server answered ${response.status}.`,
        );
    }
  }

  /** Parse a JSON body, or fail with something readable. */
  private async json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new ConnectError(
        "malformed",
        "The server's reply was not readable JSON. Nothing was configured.",
      );
    }
  }
}

/** Whether a status ends the wait. */
export function isTerminal(status: ConnectStatus): boolean {
  return (
    status === "approved" ||
    status === "collected" ||
    status === "denied" ||
    status === "failed" ||
    status === "expired"
  );
}

/**
 * The wire shapes, named.
 *
 * Written out rather than read field-by-field off a `Record<string, unknown>`,
 * because the two are not the same thing: one states the contract this client
 * holds the server to, and the other silently turns a renamed or missing field
 * into an empty string and carries on. The handoff's whole value is that
 * nothing is configured unless a real credential arrived — so a response that
 * does not contain one has to be an error here, not a `""` three layers down.
 */
type SessionWire = {
  session_id: string;
  session_secret: string;
  user_code: string;
  approve_url: string;
  expires_at: string;
};

type GrantWire = {
  api_key: string;
  namespace: string;
  space?: string | null;
  backend_url?: string;
  mcp_url?: string;
};

/** A field-level validation failure, named for the message it produces. */
function malformed(what: string): ConnectError {
  return new ConnectError(
    "malformed",
    `The server's reply is missing ${what}. This is a server-side problem; nothing was configured.`,
  );
}

function requireString(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw malformed(`"${field}"`);
  }
  return value;
}

function optionalString(
  source: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = source[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformed("a JSON object");
  }
  return value as Record<string, unknown>;
}

/** Validate a `begin` response into a {@link Session}. */
export function parseSession(body: unknown): Session {
  const raw = asObject(body);
  const wire: SessionWire = {
    session_id: requireString(raw, "session_id"),
    session_secret: requireString(raw, "session_secret"),
    user_code: requireString(raw, "user_code"),
    approve_url: requireString(raw, "approve_url"),
    expires_at: requireString(raw, "expires_at"),
  };
  const expiresAt = new Date(wire.expires_at);
  if (Number.isNaN(expiresAt.getTime())) throw malformed('a readable "expires_at"');
  return {
    sessionId: wire.session_id,
    secret: wire.session_secret,
    userCode: wire.user_code,
    approveUrl: wire.approve_url,
    expiresAt,
  };
}

/** Validate a `claim` response into a {@link Grant}. */
export function parseGrant(body: unknown, fallbackBackend: string): Grant {
  const raw = asObject(body);
  const wire: GrantWire = {
    api_key: requireString(raw, "api_key"),
    namespace: requireString(raw, "namespace"),
    space: optionalString(raw, "space"),
    backend_url: optionalString(raw, "backend_url"),
    mcp_url: optionalString(raw, "mcp_url"),
  };
  return {
    apiKey: wire.api_key,
    namespace: wire.namespace,
    space: wire.space ?? undefined,
    // The server tells us where to point clients; falling back to the address
    // we dialled is correct and not a guess, since that is the deployment that
    // issued the key.
    backendUrl: wire.backend_url ?? fallbackBackend,
    // No fallback, on purpose — see `Grant.mcpUrl`. An absent endpoint is a
    // deployment that hosts no MCP server, which is a real configuration and
    // not a gap to paper over.
    mcpUrl: wire.mcp_url,
  };
}

/** A status, if `raw` names one. */
function asStatus(raw: string | undefined): ConnectStatus | undefined {
  switch (raw) {
    case "pending":
    case "approving":
    case "approved":
    case "collected":
    case "denied":
    case "failed":
    case "expired":
      return raw;
    default:
      return undefined;
  }
}

/** The `status` out of an event's JSON body, for a server that sends no event name. */
function readStatus(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : undefined;
  } catch {
    return undefined;
  }
}

/** The human-readable half of an RFC 9457 problem document, if there is one. */
async function problemDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      detail?: unknown;
      title?: unknown;
      error?: { message?: unknown };
    };
    for (const candidate of [body.detail, body.error?.message, body.title]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  } catch {
    // Not JSON, or empty. The status code is the whole story then.
  }
  return undefined;
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function abortError(): ConnectError {
  return new ConnectError("cancelled", "Cancelled.");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
