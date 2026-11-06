/**
 * The commands, one per file.
 *
 * Exports only. `cli.ts` dispatches through this barrel, so adding a command
 * is a new file plus one line here plus one case in the dispatcher — and
 * nothing else has to know where it lives.
 */

export {
  connect,
  type ConnectOptions,
  DEFAULT_BACKEND,
  defaultMachineName,
} from "./connect.js";

export { doctor, type DoctorOptions } from "./doctor.js";
