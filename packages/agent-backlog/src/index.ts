import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type { AgentSettings, WorkflowIO } from "@tomrade/agent";
import type {} from "@tomrade/boards";
import type {} from "@tomrade/items";
import type { Item } from "@tomrade/domain";
import type { LlmService } from "@tomrade/llm";
import { defineTool, type RunHandle } from "@tomrade/tools";
import { dossierSchema, emptyDossier, readiness, renderDossier, REQUIRED_FIELDS, type Dossier, type RequiredField } from "./dossier.js";
import { applyPlan, findGaps, generatePlan, planSchema, type Plan } from "./plan.js";
import { PLAYBOOKS } from "./playbooks.js";
import { findSimilar, findSimilarBatch, overlap } from "./similar.js";

export { dossierSchema, emptyDossier, readiness, renderDossier, REQUIRED_FIELDS, type Dossier } from "./dossier.js";
export { findSimilar, findSimilarBatch, overlap, tokens } from "./similar.js";
export { applyPlan, findGaps, generatePlan, planSchema, type ApplyOutcome, type Plan } from "./plan.js";
export { PLAYBOOKS } from "./playbooks.js";

export const DEDUP_RULE = "dedup-before-create";

const QUESTIONS: Record<RequiredField, string> = {
  goal: "What should this product achieve, in one or two sentences?",
  users: "Who is it for?",
  platform: "What platform or form factor? (e.g. Flutter mobile app, web, CLI)",
  coreLoop: "What are the 1–3 things it must do? (comma-separated)",
  outOfScope: "Anything explicitly out of scope? (comma-separated, or “-” for none)",
  successSignal: "How will you know it works? Name one success signal."
};

const LIST_FIELDS: ReadonlySet<RequiredField> = new Set(["coreLoop", "outOfScope"]);

const toList = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (!trimmed || /^(-|none|无|没有)$/i.test(trimmed)) return ["-"];
  return trimmed.split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean);
};

const answerText = (answer: string | string[] | undefined): string => (Array.isArray(answer) ? answer.join(", ") : (answer ?? ""));

interface WizardState {
  dossier: Dossier;
  asked: RequiredField | null;
}

export default {
  name: "agent-backlog",
  inject: ["agent", "tools", "items", "boards", "db", "settings"],
  apply(ctx: Context) {
    const llm = (): LlmService | null => (ctx.get("llm") as LlmService | undefined) ?? null;
    const existingOf = (projectId?: string): Item[] => ctx.items.list(projectId ? { projectId } : {});
    const dossierOf = (run: RunHandle): Dossier => {
      const card = ctx.agent.store.cards(run.projectId, run.threadId).find((c) => c.id === "dossier");
      return card ? dossierSchema.parse(card.data) : emptyDossier();
    };
    const saveDossier = (run: RunHandle, dossier: Dossier) =>
      ctx.agent.setCard(run.id, { id: "dossier", schema: "backlog.dossier", title: "Requirement dossier", data: dossier });
    const confirmThreshold = () => ((ctx.settings.get().agent as AgentSettings | undefined)?.confirmWritesOver ?? 0);

    // ── tools ──────────────────────────────────────────────────────────────
    ctx.tools.register(
      defineTool({
        name: "find_similar",
        title: "Find similar items",
        description:
          "Check proposed items against the existing backlog before creating them. Pass one {title, body?} — or {titles: [...]} to check MANY AT ONCE for the cost of one call (always batch when you have several). Returns a duplicate/related/none verdict with matches; related matches often name the right parent epic.",
        input: z.object({
          title: z.string().min(1).optional(),
          body: z.string().optional(),
          titles: z.array(z.string().min(1)).max(20).optional(),
          limit: z.number().int().min(1).max(20).optional()
        }),
        execute: async ({ title, body, titles, limit }, inv) => {
          const existing = existingOf(inv.projectId);
          if (titles?.length) {
            const results = await findSimilarBatch(llm(), titles.map((t) => ({ title: t })), existing, limit);
            return { results: titles.map((t, i) => ({ title: t, ...results[i] })) };
          }
          if (!title) throw new Error("pass title, or titles for a batch");
          return findSimilar(llm(), { title, body }, existing, limit);
        }
      })
    );

    ctx.tools.register(
      defineTool({
        name: "find_gaps",
        title: "Find gaps",
        description: "Compare a stated requirement against the existing backlog and list what is still missing to satisfy it.",
        input: z.object({ requirement: z.string().min(1) }),
        execute: ({ requirement }, inv) => findGaps(llm(), requirement, existingOf(inv.projectId))
      })
    );

    ctx.tools.register(
      defineTool({
        name: "update_dossier",
        title: "Update the requirement dossier",
        description:
          "Merge what you learned into this thread's requirement dossier (the durable intake state). Returns the dossier plus readiness: which required fields are still missing. Record what the user said before asking anything.",
        input: z.object({ patch: dossierSchema.partial() }),
        execute: ({ patch }, inv) => {
          if (!inv.run) throw new Error("update_dossier runs inside an assistant thread");
          const merged = dossierSchema.parse({ ...dossierOf(inv.run), ...patch });
          saveDossier(inv.run, merged);
          return { dossier: merged, readiness: readiness(merged) };
        }
      })
    );

    // ── the planning workflow ─────────────────────────────────────────────
    interface PlanState {
      requirement: string;
      rootTitle: string;
      plan: Plan | null;
      writes: number;
    }
    ctx.agent.workflow<{ requirement?: string; rootTitle?: string }, PlanState>({
      id: "plan_and_apply",
      title: "Plan & apply",
      description:
        "Decompose a requirement into a root epic → epics → PR-sized features and write the whole tree in ONE transaction (revertible in one click). Pass {requirement} for a written spec, or {} to use this thread's dossier.",
      input: z.object({ requirement: z.string().optional(), rootTitle: z.string().optional() }),
      state: z.object({ requirement: z.string(), rootTitle: z.string(), plan: planSchema.nullable(), writes: z.number() }),
      entry: "plan",
      accepts: "options",
      start(input, io) {
        const dossier = dossierOf(io.run);
        const fromDossier = readiness(dossier).filled > 0 ? renderDossier(dossier) : "";
        const requirement = input.requirement?.trim() || fromDossier;
        if (!requirement) throw new Error("nothing to plan: pass {requirement}, or fill the dossier first (update_dossier)");
        const rootTitle = input.rootTitle?.trim() || dossier.title || dossier.goal || requirement.split("\n")[0].replace(/^#\s*/, "").slice(0, 70);
        return { requirement, rootTitle, plan: null, writes: 0 };
      },
      steps: {
        async plan(state, io, answer) {
          if (answer !== undefined) {
            return answerText(answer).startsWith("Apply") ? { next: "apply", state } : { done: { cancelled: true, reason: "the user declined the plan" } };
          }
          const existing = existingOf(io.run.projectId);
          const plan = await generatePlan(io.llm, state.requirement, existing);
          const features = plan.epics.reduce((n, e) => n + e.features.length, 0);
          const next: PlanState = { ...state, plan, writes: 1 + plan.epics.length + features };
          io.emit({ type: "card", id: "proposal", schema: "backlog.proposal", title: "Plan proposal", data: plan });
          const threshold = confirmThreshold();
          if (threshold > 0 && next.writes > threshold) {
            return { ask: { text: `This plan writes ${next.writes} items (1 root epic, ${plan.epics.length} epics, ${features} features). Apply it?`, options: ["Apply", "Cancel"] }, state: next };
          }
          return { next: "apply", state: next };
        },
        apply(state, io) {
          const outcome = applyPlan(ctx, {
            projectId: io.run.projectId,
            author: io.run.author,
            rootTitle: state.rootTitle,
            rootBody: state.requirement,
            plan: state.plan!,
            existing: existingOf(io.run.projectId)
          });
          return { done: outcome };
        }
      }
    });

    // ── the intake wizard (what the scripted engine runs; the loop prefers conversational intake) ──
    ctx.agent.workflow<{ seed?: string }, WizardState>({
      id: "intake_wizard",
      title: "Requirement intake (fixed questions)",
      description: "Walk the six required dossier fields one question at a time, then plan and write the backlog. Fully deterministic.",
      input: z.object({ seed: z.string().optional() }),
      state: z.object({ dossier: dossierSchema, asked: z.enum(REQUIRED_FIELDS).nullable() }),
      entry: "ask",
      accepts: "text",
      start: (input) => ({ dossier: dossierSchema.parse({ goal: input.seed ?? "" }), asked: null }),
      steps: {
        ask(state, io, answer) {
          if (state.asked && answer !== undefined) {
            const raw = answerText(answer);
            const dossier = dossierSchema.parse({ ...state.dossier, [state.asked]: LIST_FIELDS.has(state.asked) ? toList(raw) : raw.trim() });
            saveDossier(io.run, dossier);
            state = { dossier, asked: null };
          }
          const missing = readiness(state.dossier).missing;
          if (!missing.length) return { next: "confirm", state };
          return { ask: { text: `(${readiness(state.dossier).filled + 1}/${REQUIRED_FIELDS.length}) ${QUESTIONS[missing[0]]}`, freeText: true }, state: { ...state, asked: missing[0] } };
        },
        async confirm(state, io, answer) {
          if (answer === undefined) return { ask: { text: "Dossier complete. Plan the backlog and write it now?", options: ["Go", "Stop"] }, state };
          if (answerText(answer) !== "Go") return { done: { dossier: state.dossier, applied: false } };
          const requirement = renderDossier(state.dossier);
          const plan = await generatePlan(io.llm, requirement, existingOf(io.run.projectId));
          const outcome = applyPlan(ctx, {
            projectId: io.run.projectId,
            author: io.run.author,
            rootTitle: state.dossier.title || state.dossier.goal.slice(0, 70) || "Requirement",
            rootBody: requirement,
            plan,
            existing: existingOf(io.run.projectId)
          });
          io.emit({ type: "text", text: `Created ${outcome.created.length} items under ${outcome.rootKey}.${outcome.skipped.length ? ` Skipped ${outcome.skipped.length} already covered.` : ""}` });
          return { done: outcome };
        }
      }
    });

    // ── the guarantee: no agent create without a duplicate check ──────────
    ctx.agent.policy({
      id: DEDUP_RULE,
      async before(call, next) {
        if (call.name !== "create_item" || call.run.waivers.has(DEDUP_RULE)) return next();
        const title = ((call.args as { title?: string }).title ?? "").trim();
        const queried = (args: unknown): string[] => {
          const a = args as { title?: string; titles?: string[] };
          return [a.title ?? "", ...(a.titles ?? [])].filter(Boolean);
        };
        const checked = call.run.ledger.find((e) => e.ok && e.tool === "find_similar" && queried(e.args).some((q) => overlap(q, title) >= 0.3));
        if (!checked) {
          throw new Error(
            `Duplicate check required before creating "${title}": call find_similar({ title: ${JSON.stringify(title)} }) first — or, if the user explicitly wants it anyway, ask_user with waiveRule "${DEDUP_RULE}".`
          );
        }
        return next();
      }
    });

    for (const playbook of PLAYBOOKS) ctx.agent.playbook(playbook);
  }
};
