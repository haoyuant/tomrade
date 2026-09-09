import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Context } from "cordis";
import { z } from "zod";
import { it, expect } from "vitest";
import { Tools } from "@tomrade/tools";
import { Mcp } from "@tomrade/mcp";
import { createClaudeCodeEngine } from "@tomrade/engine-claude-code";
import { createCodexEngine } from "@tomrade/engine-codex";
import { evaluateTurn, summarizeEvaluation, type EvaluationObservation, type TurnIO, type TurnInput, type Block } from "@tomrade/agent";

/** Opt-in paid-provider evaluation. Each arm owns fresh provider history and fixture state. */
it.skipIf(!process.env.TOMRADE_EVAL_ENGINE)("paired production-adapter A/B", async () => {
  const provider = process.env.TOMRADE_EVAL_ENGINE!;
  if (!["codex", "claude-code"].includes(provider)) throw new Error("TOMRADE_EVAL_ENGINE must be codex or claude-code");
  const model = process.env.TOMRADE_EVAL_MODEL;
  if (!model) throw new Error("Set TOMRADE_EVAL_MODEL to a fixed provider model ID");
  const effort = process.env.TOMRADE_EVAL_EFFORT ?? "low";
  const command = process.env.TOMRADE_EVAL_COMMAND ?? (provider === "codex" ? "codex" : "claude");
  const repetitions = Number(process.env.TOMRADE_EVAL_REPETITIONS ?? "3");
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20) throw new Error("Repetitions must be 1–20");
  const version = execFileSync(command, ["--version"], { encoding: "utf8" }).trim();
  const output = path.resolve(process.env.TOMRADE_EVAL_OUTPUT ?? `artifacts/agent-eval/${provider}-${Date.now()}.json`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-eval-"));
  const observations: EvaluationObservation[] = [];
  const fixtures = [
    { id: "recall", prompts: ["Remember this identifier: cobalt-731. Reply exactly READY.", "What identifier did I ask you to remember? Reply with only that identifier."], expected: ["READY", "cobalt-731"] },
    { id: "backlog", prompts: ["How many tickets are there? Use count_items and report the count.", "The current card contains an updated count. Call count_items again and report today's ticket count."], expected: ["7", "11"] },
    { id: "write", prompts: ["Use save_note to save the exact note alpha. Then say SAVED.", "Use save_note to replace the note with the exact text beta. Then say SAVED."], expected: ["alpha", "beta"] },
    { id: "code", prompts: ["Fix add in math.mjs so it returns the numeric sum. Run node check.mjs to verify. Do not modify check.mjs. Do not commit.", "Add an exported subtract(a,b) function to math.mjs. Keep add working. Run node check.mjs. Do not modify check.mjs or commit."], expected: ["add", "subtract"] }
  ];
  const manifest = { schemaVersion: 1, provider, model, effort, version, repetitions,
    fixtureHash: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex"),
    tools: ["count_items", "save_note"], allowTools: ["Read", "Edit", "Write", "Bash"],
    notes: ["Alternating AB/BA order; independent history and fixture state per arm.",
      "Provider prompt caches may be shared across arms; report order and repeat before interpreting latency.",
      "Costs are provider estimates, null where unavailable. TTFT requires real deltas.",
      "Success checks are deterministic smoke-task correctness, not a general coding-quality benchmark."] };
  const flush = () => {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify({ manifest, observations, summary: summarizeEvaluation(observations) }, null, 2));
  };
  try {
    for (let repetition = 0; repetition < repetitions; repetition++) {
      for (const fixture of fixtures) {
        const order = repetition % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const;
        for (const variant of order) {
          const ctx = new Context();
          await ctx.plugin(Tools);
          await ctx.plugin(Mcp, { port: 0 });
          await new Promise((resolve) => setTimeout(resolve, 0));
          const cwd = path.join(root, fixture.id);
          fs.mkdirSync(cwd, { recursive: true });
          fs.writeFileSync(path.join(cwd, "math.mjs"), "export const add = (a,b) => a-b;\n");
          const testSource = "import assert from 'node:assert/strict'; import {add} from './math.mjs'; assert.equal(add(2,3),5); assert.equal(add(-2,3),1); console.log('PASS');\n";
          fs.writeFileSync(path.join(cwd, "check.mjs"), testSource);
          let count = 7;
          let note = "";
          const calls: { name: string; run: string }[] = [];
          ctx.tools.register({ name: "count_items", title: "Count tickets", description: "Authoritative ticket count", input: z.object({}), execute: () => ({ count }) });
          ctx.tools.register({ name: "save_note", title: "Save note", description: "Replace the project's note", input: z.object({ text: z.string() }), execute: ({ text }) => { note = text; return { saved: text }; } });
          const engine = provider === "codex" ? createCodexEngine(ctx) : createClaudeCodeEngine(ctx);
          const threadId = randomUUID();
          let resume: string | undefined;
          const input: TurnInput = { threadId, projectId: "eval", purpose: fixture.id === "code" ? "code" : "backlog",
            cwd, input: { kind: "text", text: "" }, messages: [], cards: [], brief: "Isolated evaluation fixture.", pending: null,
            options: { command, model, effort, allowTools: manifest.allowTools,
              transport: variant === "baseline" ? "cli" : provider === "codex" ? "app-server" : "sdk" } };
          try {
            for (let turn = 0; turn < fixture.prompts.length; turn++) {
              count = turn ? 11 : 7;
              input.cards = [{ id: "count", threadId, schema: "fixture", title: "Today's count", data: { count }, version: turn, updatedBy: "human", updatedAt: Date.now() }];
              input.input = { kind: "text", text: fixture.prompts[turn] };
              const runId = randomUUID();
              const abort = new AbortController();
              const timer = setTimeout(() => abort.abort(), 180_000);
              const io: TurnIO = { resume, signal: abort.signal, llm: null,
                run: { id: runId, threadId, projectId: "eval", author: engine.author, ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() },
                emit() {}, delta() {}, progress() {},
                tools: { describe: () => ctx.tools.describe(), execute: async (name, args) => {
                  calls.push({ name, run: runId });
                  return ctx.tools.execute(name, args, { by: engine.author, projectId: "eval", run: io.run });
                } }, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] } };
              const check = (_result: unknown, blocks: Block[]) => {
                const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
                if (fixture.id === "write") return { correctState: note === fixture.expected[turn], attributedToThisRun: calls.some((c) => c.run === runId && c.name === "save_note") };
                if (fixture.id === "code") {
                  let passed = false;
                  try {
                    execFileSync(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict'; import * as m from './math.mjs'; assert.equal(m.add(2,3),5); assert.equal(m.add(-2,3),1); ${turn ? "assert.equal(m.subtract(5,3),2);" : ""}`], { cwd, timeout: 5000 });
                    passed = true;
                  } catch {}
                  return { hiddenTestsPass: passed, testUnmodified: fs.readFileSync(path.join(cwd, "check.mjs"), "utf8") === testSource };
                }
                return { correctAnswer: text.includes(fixture.expected[turn]), ...(fixture.id === "backlog" ? { usedAuthoritativeTool: calls.some((c) => c.run === runId && c.name === "count_items") } : {}) };
              };
              try {
                const measured = await evaluateTurn({ engine, input, io, caseId: fixture.id, repetition, variant, turn, check });
                resume = measured.result.resume ?? resume;
                observations.push(measured.observation);
                flush();
              } finally { clearTimeout(timer); }
            }
          } finally { await ctx.fiber.dispose(); }
        }
      }
    }
  } finally { flush(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log(`Evaluation written to ${output}`);
  const baseline = observations.filter((r) => r.variant === "baseline");
  const candidate = observations.filter((r) => r.variant === "candidate");
  expect(candidate.length).toBe(baseline.length);
  // Fail the smoke gate on a candidate error or correctness regression. Small
  // samples do not establish statistical equivalence or a latency improvement.
  expect(candidate.every((r) => r.success)).toBe(true);
  expect(candidate.filter((r) => r.turn > 0).every((r) => r.metrics?.runtime === "warm")).toBe(true);
}, 60 * 60_000);
