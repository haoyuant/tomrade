import type { StoredRole } from "./store.js";

/** What a role adds to what its agent is told: the role's own instructions, named as the project's. */
export const roleSection = (role: Pick<StoredRole, "title" | "instructions">): string =>
  [`<role name=${JSON.stringify(role.title)}>`, `This project does this work as its role "${role.title}". The role's instructions, which add to what you were asked and never replace it:`, "", role.instructions, "</role>"].join("\n");
