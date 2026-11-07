/**
 * `brain disconnect` — take Brain off this machine.
 *
 * ## Why a command, rather than a paragraph in the README
 *
 * `connect` writes to six places: an MCP server in three JSON config files, an
 * entry in Codex's TOML, a Claude Code plugin with a credential in the OS
 * keychain, and a directory of skills under `~/.agents/skills`. Nobody is
 * going to find all six by hand, and the two that matter most are the two
 * least likely to be found: the key in the keychain, and the skills, which sit
 * in a shared directory that has nothing to do with Brain.
 *
 * A tool that can put a credential on a machine and cannot take it off is
 * asking for trust it has not earned.
 *
 * ## The rule this command is built around
 *
 * **Remove only what we can show we wrote.** Every config it touches belongs
 * to the user and holds their other servers; the skills directory is shared
 * with every other agent tool on the machine. So each removal is gated on
 * evidence of ownership — a Brain key on the server entry, our marker file
 * beside the skill, our source on the marketplace — and anything unproven is
 * reported and left exactly where it is. A `disconnect` that deletes
 * somebody's unrelated `brain` server is worse than one that leaves ours
 * behind, because the second is visible and the first is not.
 *
 * ## What it deliberately does not do
 *
 * - **It does not revoke the key.** The key keeps working after every local
 *   trace of it is gone, and only the dashboard can retire it — so that is the
 *   closing instruction rather than a silent API call from a cleanup command.
 * - **It does not delete the backups.** `connect` copies a config aside before
 *   its first write; those copies are the user's own configuration from before
 *   Brain existed, and deleting them is the one step here that cannot be
 *   undone. They are named instead.
 */

import { existsSync } from "node:fs";
import {
  type ClientTarget,
  MARKETPLACE,
  type Removal,
  SERVER_NAME,
  backupPath,
  detect,
  knownIds,
  removeMarketplace,
  removeSkills,
  resolveClients,
  skillsDir,
  uninstall,
} from "../clients/index.js";
import { type Mark, dim, field, heading, item, nextSteps, problem, say } from "../ui.js";

export type DisconnectOptions = {
  /** Restrict to these client ids. Empty means every detected client. */
  clients: string[];
  /** Leave the shared skills in place and remove only the servers. */
  keepSkills: boolean;
  dryRun: boolean;
};

/** Run the command. Returns a process exit code. */
export function disconnect(options: DisconnectOptions): number {
  heading(
    "brain disconnect",
    "Remove Brain from this machine — the servers, the plugin and the skills.",
  );

  const chosen = resolveClients(options.clients);
  if (!Array.isArray(chosen)) {
    problem(chosen.what, chosen.remedy);
    return 1;
  }

  // Every named client is visited; an unnamed run visits the ones that are
  // actually here. Deliberately NOT gated on `detect` for a named client: a
  // client somebody has since uninstalled can still have our server in a
  // config file it left behind, and that file is exactly what this command is
  // for.
  const explicit = options.clients.length > 0;
  const present = chosen.filter((t) => (explicit ? true : detect(t)));

  say();
  field("server", `"${SERVER_NAME}"`);
  field(
    "clients",
    present.length > 0 ? present.map((t) => t.label).join(", ") : dim("none found"),
  );

  if (present.length === 0) {
    problem(
      "No supported agent client found on this machine.",
      `Nothing to remove. Name one anyway with --client ${knownIds().join("|")}`,
    );
    return 1;
  }

  say();
  say(`  ${dim(options.dryRun ? "would remove" : "removed")}`);
  const removals: Removal[] = present.map((t) => uninstall(t, options.dryRun));
  for (const removal of removals) {
    item(markOf(removal.status), removal.client.label, removal.detail);
  }

  // The marketplace, after the plugin that came from it. Left alone unless it
  // is ours and empty — see `removeMarketplace`, where the guard is.
  const claudeCode = present.find((t) => t.writer.kind === "plugin");
  const marketplace =
    claudeCode?.writer.kind === "plugin"
      ? removeMarketplace(claudeCode.writer.bin, options.dryRun)
      : undefined;
  if (marketplace) {
    item(markOf(marketplace.status), `marketplace: ${MARKETPLACE}`, marketplace.detail);
  }

  // Skills are machine-wide rather than per-client, so they are removed once,
  // not once per client — and only the ones carrying our marker.
  const skills = options.keepSkills ? [] : removeSkills(options.dryRun);
  if (options.keepSkills) {
    item("skip", "skills", `left in ${skillsDir()} — --keep-skills`);
  } else if (skills.length === 0) {
    item("skip", "skills", `none of ours in ${skillsDir()}`);
  } else {
    for (const skill of skills) {
      item(
        skill.status === "failed" ? "fail" : skill.status === "skipped" ? "skip" : "ok",
        `skill: ${skill.name}`,
        skill.detail,
      );
    }
  }

  if (options.dryRun) {
    nextSteps("dry run", ["Nothing was changed. Drop --dry-run to apply the above."]);
    return 0;
  }

  const failed = removals.filter((r) => r.status === "failed");
  const kept = removals.filter((r) => r.status === "kept");
  const removed = removals.filter((r) => r.status === "removed");

  const steps: string[] = [];
  if (removed.length > 0) {
    // Same reason as on the way in: a client reads its MCP servers at start-up,
    // so one that is still running still has Brain's tools loaded.
    steps.push(`Restart ${removed.map((r) => r.client.label).join(" and ")}.`);
    steps.push("");
  }

  // The part that is not on this machine, and the only step that actually ends
  // the access. Said plainly, because a user who runs `disconnect` to revoke
  // their key and is not told this walks away believing they have.
  steps.push(
    "Your API key still works — removing it from this machine does not retire it.",
    dim("  Revoke it in the dashboard if this machine should no longer have access."),
  );

  const leftovers = backupsFor(present);
  if (leftovers.length > 0) {
    steps.push(
      "",
      `${leftovers.length === 1 ? "A copy" : "Copies"} of your config from before Brain touched it ${leftovers.length === 1 ? "is" : "are"} kept, in case a merge went wrong:`,
      ...leftovers.map((path) => dim(`  ${path}`)),
      dim("  Delete them whenever you like; nothing reads them."),
    );
  }
  nextSteps("next", steps);

  if (kept.length > 0) {
    problem(
      `${kept.length} ${kept.length === 1 ? "entry was" : "entries were"} left alone because ${kept.length === 1 ? "it is" : "they are"} not ours.`,
      "The lines marked – above say where. Remove them by hand if you want them gone.",
    );
  }
  if (failed.length > 0) {
    problem(
      `${failed.length} of ${removals.length} clients could not be cleaned up.`,
      "The lines marked ✗ above say what went wrong.",
    );
    return 1;
  }
  return 0;
}

/** A removal's mark. */
function markOf(status: Removal["status"]): Mark {
  switch (status) {
    case "removed":
      return "ok";
    case "would":
    case "absent":
      return "skip";
    case "kept":
      // A warning and not a tick: something of ours may still be there, and
      // the whole point of this command is that nothing is.
      return "warn";
    case "failed":
      return "fail";
  }
}

/**
 * The backup files `connect` left beside the configs it edited.
 *
 * Named rather than deleted. They hold the user's own configuration, which may
 * include credentials for their other servers, and they are the only way back
 * from a merge that went wrong months ago — so the last act of a cleanup
 * command is not to throw them away.
 */
function backupsFor(clients: ClientTarget[]): string[] {
  const found: string[] = [];
  for (const client of clients) {
    if (client.writer.kind !== "json") continue;
    const backup = backupPath(client.writer.path);
    if (existsSync(backup)) found.push(backup);
  }
  return found;
}
