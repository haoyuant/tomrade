import { fileURLToPath } from "node:url";
import { loadPlaybookDir, type Playbook } from "@tomradex/agent";
import { errorMessage } from "@tomradex/contracts";

/** `playbooks/<name>/SKILL.md` at the package root — the same format user playbooks use. `../playbooks` resolves from `src/` and `dist/` alike. */
export const PLAYBOOKS: Playbook[] = loadPlaybookDir(fileURLToPath(new URL("../playbooks", import.meta.url)), (file, err) => {
  throw new Error(`code-link playbook ${file} failed to load: ${errorMessage(err)}`);
});
