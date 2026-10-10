import { fileURLToPath } from "node:url";
import { loadPlaybookDir, type Playbook } from "@tomradex/agent";

/**
 * The four backlog playbooks, one SKILL.md per `playbooks/<name>/` at the
 * package root — the same file format user playbooks use, editable without
 * touching code. `../playbooks` resolves there from `src/` and `dist/` alike.
 */
export const PLAYBOOKS: Playbook[] = loadPlaybookDir(fileURLToPath(new URL("../playbooks", import.meta.url)), (file, err) => {
  throw new Error(`backlog playbook ${file} failed to load: ${err instanceof Error ? err.message : String(err)}`);
});

if (PLAYBOOKS.length === 0) throw new Error("agent-backlog found no playbooks — the playbooks/ directory did not ship with the package");
