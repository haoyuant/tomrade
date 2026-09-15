import { z } from "zod";

export const dossierSchema = z.object({
  title: z.string().default(""),
  goal: z.string().default(""),
  materials: z.array(z.string()).default([]),
  outcomes: z.array(z.string()).default([]),
  users: z.string().default(""),
  platform: z.string().default(""),
  /** The 1–3 things the product must do. */
  coreLoop: z.array(z.string()).default([]),
  niceToHaves: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  successSignal: z.string().default(""),
  openQuestions: z.array(z.object({ q: z.string(), status: z.enum(["open", "answered", "deferred"]).default("open"), a: z.string().optional() })).default([]),
  decisions: z.array(z.object({ what: z.string(), why: z.string() })).default([])
});
export type Dossier = z.infer<typeof dossierSchema>;

export const emptyDossier = (): Dossier => dossierSchema.parse({});

export const REQUIRED_FIELDS = ["goal", "materials", "constraints", "outcomes", "successSignal"] as const;
export type RequiredField = (typeof REQUIRED_FIELDS)[number];

const filled = (dossier: Dossier, field: RequiredField): boolean => {
  const value = dossier[field];
  // outOfScope counts once touched: "nothing out of scope" is itself an answer, recorded as ["-"].
  return Array.isArray(value) ? value.length > 0 : value.trim().length > 0;
};

export interface Readiness {
  filled: number;
  required: number;
  missing: RequiredField[];
}

/** Domain-specific fields remain optional. The user's "go" overrides readiness. */
export function readiness(dossier: Dossier): Readiness {
  const missing = REQUIRED_FIELDS.filter((f) => !filled(dossier, f));
  return { filled: REQUIRED_FIELDS.length - missing.length, required: REQUIRED_FIELDS.length, missing };
}

const list = (items: string[]): string => (items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none)");

/** The dossier as the root epic's body — visible on the board, versioned, undoable. */
export function renderDossier(dossier: Dossier): string {
  const parts = [
    `# ${dossier.title || dossier.goal || "Requirement"}`,
    `**Goal** ${dossier.goal}`,
    `## Materials\n${list(dossier.materials)}`,
    `## Expected outcomes\n${list(dossier.outcomes)}`,
    `**Users** ${dossier.users}`,
    `**Platform** ${dossier.platform}`,
    `**Success signal** ${dossier.successSignal}`,
    `## Core loop\n${list(dossier.coreLoop)}`,
    `## Out of scope\n${list(dossier.outOfScope)}`
  ];
  if (dossier.niceToHaves.length) parts.push(`## Nice to have\n${list(dossier.niceToHaves)}`);
  if (dossier.constraints.length) parts.push(`## Constraints\n${list(dossier.constraints)}`);
  if (dossier.decisions.length) parts.push(`## Decisions\n${dossier.decisions.map((d) => `- ${d.what} — ${d.why}`).join("\n")}`);
  return parts.join("\n\n");
}
