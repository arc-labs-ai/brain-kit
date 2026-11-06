/**
 * The client layer: which agent clients exist, how each is configured, and how
 * the shared pieces (JSON merging, subprocesses, portable skills) work.
 *
 * Exports only. Everything here is implemented in a sibling file, and callers
 * import from this barrel rather than reaching past it — so moving a function
 * between `install.ts` and `targets.ts` is not a change to anyone else's
 * imports.
 */

export {
  appSupport,
  type ClientTarget,
  knownIds,
  type ServerSpec,
  targetById,
  targets,
  type Writer,
} from "./targets.js";

export {
  detect,
  install,
  inspect,
  MARKETPLACE,
  MARKETPLACE_SOURCE,
  type Outcome,
  PLUGIN,
  SERVER_PACKAGE,
} from "./install.js";

export {
  mergeServer,
  readServer,
  removeServer,
  type ServerEntry,
  WriteError,
  type WriteResult,
} from "./json.js";

export {
  available,
  jsonFrom,
  looksUnsupported,
  reasonFrom,
  run,
  type RunResult,
} from "./run.js";

export {
  bundledSkillsDir,
  installSkills,
  installedSkills,
  removeSkills,
  type SkillResult,
  skillName,
  skillsDir,
} from "./skills.js";
