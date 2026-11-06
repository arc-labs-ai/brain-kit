/**
 * The client half of the `connect` handoff: the session flow and the SSE
 * reader it is built on.
 *
 * Exports only. `sse.ts` is an implementation detail of `session.ts` and is
 * re-exported here for its tests rather than for callers — nothing outside
 * this folder parses an event stream.
 */

export {
  ConnectClient,
  type ConnectClientOptions,
  ConnectError,
  type ConnectErrorKind,
  type ConnectStatus,
  type Grant,
  isTerminal,
  parseGrant,
  parseSession,
  type Session,
} from "./session.js";

export { readEvents, type ServerEvent, SseParser } from "./sse.js";
