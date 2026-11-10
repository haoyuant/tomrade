import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import { frontmatter } from "./playbooks.js";

/** What the worker model returns for a draft; the SKILL.md is assembled from it here. */
export const draftSchema = z.object({
  name: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  body: z.string().min(1)
});

export const DRAFT_SYSTEM = [
  "You turn one finished, accepted piece of work into a reusable playbook: a SKILL.md another agent follows the next time similar work comes up.",
  "Write the method, not the story: when it applies, the steps in order, the checks that proved it worked, and the traps this run hit. Generalise names and specifics that only fit this one ticket; keep commands, file conventions and checks that will hold next time.",
  "Fields: name — a short kebab-case id (letters, digits, dot, dash); title — a few words; description — one sentence starting with when to use it; body — Markdown: a short intro line, then numbered steps, then a short 'Checks' list. No frontmatter in body. Write in the language the ticket is written in."
].join("\n");

export interface DraftInput {
  key: string;
  title: string;
  body: string | null;
  workType: "coding" | "general";
  report: string | null;
  recap: string;
}

export function draftPrompt(input: DraftInput): string {
  return [
    `TICKET ${input.key}: ${input.title}`,
    input.body?.trim() ? input.body.trim() : "(no description)",
    input.report?.trim() ? `\nDELIVERY REPORT:\n${input.report.trim()}` : "",
    input.recap ? `\nWHAT THE AGENT DID:\n${input.recap}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 60) || "playbook";

/** A SKILL.md from the model's fields, with the work type it came from as its recommendation. */
export function composeSkill(draft: z.infer<typeof draftSchema>, workType: "coding" | "general"): { id: string; text: string } {
  const id = slug(draft.name);
  const meta = { name: id, title: draft.title.trim(), description: draft.description.trim(), workTypes: [workType] };
  return { id, text: `---\n${stringifyYaml(meta).trim()}\n---\n\n${draft.body.trim()}\n` };
}

/** The same SKILL.md under another id: loadPlaybookDir reads the id from `name`, so it has to say the folder's. */
export function renameSkill(text: string, id: string): string {
  const { meta, body } = frontmatter(text);
  return `---\n${stringifyYaml({ ...meta, name: id }).trim()}\n---\n\n${body}\n`;
}
