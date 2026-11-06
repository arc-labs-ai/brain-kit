# Every timer in the connect handoff, and why it is there

The handoff is event-driven end to end: a human clicks, and the waiting CLI
finds out because something told it, not because it asked again. This file
exists because "is that a timer?" kept being a good question, and the answer
should not have to be re-derived from the code each time.

A timer in this system is only legitimate if it is one of two things:

- **a scheduled action at a known future instant** — the deadline is already
  known, nothing is being guessed, and there is no event to wait for because
  the *absence* of one is the condition;
- **a watchdog** — detecting that a peer has gone away without saying so,
  which no protocol delivers as an event. You find out by trying.

Anything else is a poll wearing a different hat.

## What was removed

| Was | Replaced by |
|---|---|
| A 20s periodic re-read in the gateway's watcher, covering notifications lost by Redis pub/sub | A durable stream each reader resumes from its own position. The gap it covered cannot occur, so there is nothing to cover. |
| `while (Date.now() < expiresAt)` in the CLI, deciding expiry locally | The server emits `expired`. The wall clock jumps when NTP corrects it and when a laptop wakes — exactly when a handoff is in flight — so the local verdict could fire minutes early, or disagree with the server outright. |
| A one-hour wall-clock ceiling on `watch` | A count of consecutive attempts that learned nothing. A clock cannot tell "flaky but progressing" from "accepting streams and saying nothing"; a counter can, and any status resets it. |
| `setTimeout(…, 300)` after launching a browser, on the theory that no error yet meant success | Node's `spawn` event. The guess reported success on a machine with no browser at all, suppressing the one line that tells someone to click the link themselves. |

## What remains, and under which rule

### Scheduled actions at a known instant

| Where | What | Why it is not a poll |
|---|---|---|
| gateway `pump` | sleep until the session's `expires_at` | The instant is known when the watch starts. Nothing happens at it except our own giving-up, so there is no event to wait for. |
| gateway `MAX_WATCH` | 15 min cap on a watch task | A sanity bound on the above, in case `expires_at` is absurd. |
| Redis TTLs | session, claim, status, grant | The store's own expiry semantics, and the authority on whether a session exists. |
| `ConnectGuard` | 1 hour counting window | Inherent to a fixed-window rate limit. |
| CLI backoff | 500ms → 5s between reconnects | A deliberate delay, not an interval that asks a question. |

### Watchdogs

| Where | What | Why there is no event |
|---|---|---|
| CLI `STREAM_SILENCE_MS` | 3 missed server keep-alives ends one stream attempt | There is no event for "the network went away". A socket stays open forever against an address that no longer routes. Its expiry is a reconnect, never a verdict about the session. |
| gateway `READ_BLOCK` | 5 min `XREAD BLOCK` | `BLOCK 0` is the pure form and was the first choice. A TCP connection that dies without closing would leave the read waiting forever and this process permanently deaf. Twelve commands an hour is the price of being able to notice. |
| CLI `doctor` | 90s on the MCP handshake | A child process can hang. `exit` and stdout are the real signals and both are handled; this covers neither arriving. Generous because a cold `npx` may download the package, and reporting a slow network as a broken server would be worse than waiting. |
| CLI `run()` | per-command `spawnSync` timeout | Same, for another CLI that wedges. |

### Cosmetic

The spinner's 80ms frame interval. It draws; it decides nothing, and it is
replaced by a single printed line when stderr is not a terminal.

## The bug this audit actually found

Chasing the `XREAD BLOCK` timeout turned up something worse than a timer. The
read was running on a connection from the shared pool, and that pool hands out
round-robin **multiplexed** connections: every caller drawing the same handle
pipelines onto one socket and reads responses back in order. A blocking command
on it holds the response slot, so a five-minute block would have stalled a
share of every scope lookup, rate-limit check and idempotency claim in the
process — permanently, for as long as the gateway ran.

The listener now holds its own connection. Blocking was never the problem;
blocking on somebody else's socket was.
