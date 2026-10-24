import type {} from "cordis";
import type { Context } from "cordis";
import { z } from "zod";
import type { WorkflowIO } from "@tomradex/agent";
import type {} from "@tomradex/boards";
import type {} from "@tomradex/items";
import { languageTag, type Item, type WordsLocale } from "@tomradex/domain";
import type { LlmService } from "@tomradex/llm";
import { defineTool, type RunHandle } from "@tomradex/tools";
import { dossierSchema, emptyDossier, readiness, renderDossier, REQUIRED_FIELDS, type Dossier, type RequiredField } from "./dossier.js";
import { applyDependencies, proposeDependencies, reviewQuestion, ticketChanges, type DependencyProposal } from "./dependencies.js";
import { applyPlan, findGaps, generatePlan, planSchema, type Plan, type PlanLanguage } from "./plan.js";
import { PLAYBOOKS } from "./playbooks.js";
import { findSimilar, findSimilarBatch, overlap } from "./similar.js";
import { BACKLOG_WORDS } from "./words.js";
import { errorMessage, localeOf } from "@tomradex/contracts";

export { dossierSchema, emptyDossier, readiness, renderDossier, REQUIRED_FIELDS, type Dossier } from "./dossier.js";
export { findSimilar, findSimilarBatch, overlap, tokens } from "./similar.js";
export { applyPlan, findGaps, generatePlan, planSchema, projectSection, type ApplyOutcome, type Plan, type PlanLanguage } from "./plan.js";
export { applyDependencies, dependencyReviewSchema, proposeDependencies, REVIEW_TIMEOUT_MS, ticketChanges, type DependencyProposal, type TicketChange } from "./dependencies.js";
export { PLAYBOOKS } from "./playbooks.js";

export const DEDUP_RULE = "dedup-before-create";

const QUESTIONS: Record<RequiredField, string> = {
  goal: "What should this work achieve, in one or two sentences?",
  materials: "What materials are already available? (comma-separated, or “-” for none)",
  constraints: "What constraints must the work respect? (comma-separated, or “-” for none)",
  outcomes: "What results should be delivered? (comma-separated)",
  successSignal: "How will you know it works? Name one success signal."
};

const LIST_FIELDS: ReadonlySet<RequiredField> = new Set(["materials", "constraints", "outcomes"]);

const toList = (raw: string): string[] => {
  const trimmed = raw.trim();
  if (!trimmed || /^(-|none|无|没有)$/i.test(trimmed)) return ["-"];
  return trimmed.split(/[,，、;；\n]/).map((s) => s.trim()).filter(Boolean);
};

const LOCALES: readonly WordsLocale[] = ["en", "zh"];
const count = (w: ReturnType<typeof BACKLOG_WORDS>, n: number, one: "item" | "epic" | "ticket", many: "items" | "epics" | "tickets") => w(n === 1 ? one : many, { n });
/** The answers that write a proposed plan, in each language it is asked in. */
const APPLY = LOCALES.map((l) => BACKLOG_WORDS(l)("planApply"));
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
    // The language the person writes in this conversation; the app's when they have written nothing yet.
    const languageOf = (run: RunHandle): PlanLanguage => {
      const said = ctx.agent.store.messages(run.projectId, run.threadId)
        .filter((m) => m.role === "user" && m.block.type === "text").slice(-3)
        .map((m) => (m.block.type === "text" ? m.block.text : "")).join(" ");
      if (said.trim()) return /[\u3400-\u9fff]/.test(said) ? "zh" : "en";
      return languageTag(localeOf(ctx));
    };
    const saveDossier = (run: RunHandle, dossier: Dossier) =>
      ctx.agent.setCard(run.id, { id: "dossier", schema: "backlog.dossier", title: "Requirement dossier", data: dossier });

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
        execute: ({ requirement }, inv) => findGaps(llm(), requirement, existingOf(inv.projectId), inv.projectId ? ctx.agent.brief(inv.projectId) : null)
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
        "Decompose a requirement into a root epic → epics → independently deliverable coding or general tickets, show the person the proposed tree, and write it in ONE transaction (revertible in one click) only once they agree. Pass {requirement} for a written spec, or {} to use this thread's dossier; write requirement and rootTitle in the person's language.",
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
            return APPLY.some((word) => answerText(answer).startsWith(word)) ? { next: "apply", state } : { done: { cancelled: true, reason: "the user declined the plan" } };
          }
          const existing = existingOf(io.run.projectId);
          const plan = await generatePlan(io.llm, state.requirement, existing, languageOf(io.run), ctx.agent.brief(io.run.projectId));
          const features = plan.epics.reduce((n, e) => n + e.features.length, 0);
          const next: PlanState = { ...state, plan, writes: 1 + plan.epics.length + features };
          io.emit({ type: "card", id: "proposal", schema: "backlog.proposal", title: "Plan proposal", data: { rootTitle: state.rootTitle, ...plan } });
          // The person reads the tree before any of it is written.
          const w = BACKLOG_WORDS(localeOf(ctx));
          const text = w("planAsk", { writes: count(w, next.writes, "item", "items"), epics: count(w, plan.epics.length, "epic", "epics"), tickets: count(w, features, "ticket", "tickets") });
          return { ask: { text, options: [w("planApply"), w("planCancel")] }, state: next };
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
      description: "Ask whatever the thread's dossier still lacks, one fixed question at a time, then plan and write the backlog. Fully deterministic; a complete dossier goes straight to the plan confirmation.",
      input: z.object({ seed: z.string().optional() }),
      state: z.object({ dossier: dossierSchema, asked: z.enum(REQUIRED_FIELDS).nullable() }),
      entry: "ask",
      accepts: "text",
      literal: true,
      // The thread's dossier is where it starts: what is already there is never asked again or written over.
      start: (input, io) => {
        const dossier = dossierOf(io.run);
        return { dossier: input.seed?.trim() && !dossier.goal ? { ...dossier, goal: input.seed.trim() } : dossier, asked: null };
      },
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
          const plan = await generatePlan(io.llm, requirement, existingOf(io.run.projectId), languageOf(io.run), ctx.agent.brief(io.run.projectId));
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

    // ── dependencies follow ticket changes ────────────────────────────────
    // Runs whose ticket changes have not been reviewed yet, per thread. Best effort: a restart forgets them.
    const owed = new Map<string, Set<string>>();
    const reviewed = new Set<string>();
    const edit = z.object({ from: z.string(), to: z.string(), fromId: z.string(), toId: z.string(), reason: z.string() });
    interface ReviewState {
      runIds: string[];
      /** Asked for by name rather than after a turn: with nothing changed, it checks the whole backlog. */
      full: boolean;
      proposal: DependencyProposal | null;
      apply: string;
    }
    ctx.agent.workflow<{ runIds?: string[] }, ReviewState>({
      id: "review_dependencies",
      title: "Review dependencies",
      description:
        "Check whether ticket changes call for dependency updates and ask the user before applying them. It runs by itself after a turn that creates, deletes, cancels or re-scopes tickets; call it only when the user asks to recheck dependencies (with nothing changed, it checks the whole backlog).",
      input: z.object({ runIds: z.array(z.string()).optional() }),
      state: z.object({ runIds: z.array(z.string()), full: z.boolean(), proposal: z.object({ add: z.array(edit), remove: z.array(edit) }).nullable(), apply: z.string() }),
      entry: "review",
      accepts: "options",
      start(input, io) {
        const runIds = input.runIds ?? [...(owed.get(io.run.threadId) ?? []), io.run.id];
        owed.delete(io.run.threadId);
        for (const id of runIds) reviewed.add(id);
        return { runIds, full: !input.runIds, proposal: null, apply: "" };
      },
      steps: {
        async review(state, io, answer) {
          const projectId = io.run.projectId;
          if (answer !== undefined) {
            if (answerText(answer) !== state.apply || !state.proposal) return { done: { applied: false } };
            const outcome = applyDependencies(ctx, projectId, state.proposal, io.run.author);
            // The question was asked in the language its apply answer is in.
            const w = BACKLOG_WORDS(LOCALES.find((l) => BACKLOG_WORDS(l)("dependenciesApply") === state.apply));
            const failed = outcome.failed.map((f) => `${f.key} (${f.reason})`).join("; ");
            io.emit({ type: "note", text: w("dependenciesUpdated", { added: outcome.added, removed: outcome.removed }) + (failed ? w("dependenciesNotUpdated", { failed }) : "") });
            return { done: outcome };
          }
          const changes = ticketChanges(ctx, projectId, state.runIds);
          const model = llm();
          if ((!changes.length && !state.full) || !model || !(await model.worker()).ok) return { done: { proposed: 0 } };
          let proposal: DependencyProposal;
          io.activity(BACKLOG_WORDS(localeOf(ctx))("checkingDependencies"));
          try {
            proposal = await proposeDependencies(ctx, model, projectId, changes, { signal: io.signal, brief: ctx.agent.brief(projectId) });
          } catch (err) {
            if (!io.signal.aborted) ctx.logger.warn(`dependency review failed: ${errorMessage(err)}`);
            return { done: { proposed: 0 } };
          } finally {
            io.activity(null);
          }
          if (!proposal.add.length && !proposal.remove.length) return { done: { proposed: 0 } };
          const items = ctx.items.list({ projectId });
          const titleOf = (key: string) => items.find((i) => i.key === key)?.title ?? "";
          const locale: WordsLocale = /[\u3400-\u9fff]/.test([...changes.map((c) => c.title), ...items.slice(0, 20).map((i) => i.title)].join("")) ? "zh" : "en";
          const question = reviewQuestion(proposal, titleOf, locale);
          return { ask: { text: question.text, options: [question.apply, question.skip] }, state: { ...state, proposal, apply: question.apply } };
        }
      }
    });
    ctx.agent.followUp({
      id: "dependency-review",
      after({ projectId, threadId, runId, canAsk }) {
        if (!reviewed.has(runId) && ticketChanges(ctx, projectId, [runId]).length) {
          const runs = owed.get(threadId) ?? new Set<string>();
          runs.add(runId);
          owed.set(threadId, runs);
        }
        const runs = owed.get(threadId);
        if (!canAsk || !runs?.size) return null;
        return { workflow: "review_dependencies", args: { runIds: [...runs] } };
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
