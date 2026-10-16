/**
 * Who should hold the backlog conversation: the same conversations, each on a
 * fresh copy of the sample project, held by the loop, the built-in pi and the
 * signed-in local agents, through the app's real turn path (prompt, playbooks,
 * tools, MCP). Reports correctness, answer quality (optional judge), time,
 * tokens, cost and how often a run fails. Spends real API money and
 * subscription quota, so it runs only when started by hand.
 *
 *   pnpm build:backend
 *   TOMRADE_EVAL_PRESET=openai pnpm --filter @tomrade/desktop eval:backlog
 *
 * TOMRADE_EVAL_ARMS      engines to compare (loop,pi-builtin,claude-code,codex)
 * TOMRADE_EVAL_PRESET    model provider for loop and pi-builtin (openai, deepseek, anthropic, …);
 *                        the key comes from TOMRADE_EVAL_API_KEY or the provider's own variable
 * TOMRADE_EVAL_MODEL     that provider's model id, instead of the one quick setup picks
 * TOMRADE_EVAL_EFFORT    reasoning effort for loop and pi-builtin
 * TOMRADE_EVAL_ENGINES   per-engine options as JSON, e.g. {"claude-code":{"model":"sonnet"}}
 * TOMRADE_EVAL_REPS      repetitions of every case per engine (3)
 * TOMRADE_EVAL_CASES     only these case ids
 * TOMRADE_EVAL_JUDGE=1   also score each answer 1–5 with the preset's model
 * TOMRADE_EVAL_TIMEOUT   per-turn limit in ms (300000)
 * TOMRADE_EVAL_OUT       output folder (artifacts/backlog-eval/<time>)
 *
 * Claude Code runs under CLAUDE_CONFIG_DIR as set in the shell — the account it is signed in to pays.
 */
import { app } from "electron";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { PROVIDERS } from "@tomradex/llm";
import { boot } from "../dist/boot.js";
import { seedDesignProject } from "./seed.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, "../../..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-backlog-eval-"));
app.setPath("userData", work);

const env = process.env;
const arms = (env.TOMRADE_EVAL_ARMS ?? "loop,pi-builtin,claude-code,codex").split(",").map((s) => s.trim()).filter(Boolean);
const reps = Number(env.TOMRADE_EVAL_REPS ?? "3");
const timeoutMs = Number(env.TOMRADE_EVAL_TIMEOUT ?? "300000");
const judging = env.TOMRADE_EVAL_JUDGE === "1";
// pnpm runs this from apps/desktop; a relative folder means where the command was typed.
const out = path.resolve(env.INIT_CWD ?? process.cwd(), env.TOMRADE_EVAL_OUT ?? path.join(repoRoot, "artifacts/backlog-eval", new Date().toISOString().replace(/[:.]/g, "-")));
if (!Number.isInteger(reps) || reps < 1 || reps > 20) throw new Error("TOMRADE_EVAL_REPS must be 1–20");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (text, ...words) => words.every((w) => text.toLowerCase().includes(w.toLowerCase()));

// ── cases: each turn's check reads the project after the turn, against the seed ──
const BUGS = ["Conflict banner is dark-only", "Left-rail hover: dark class", "Chat history filter is a no-op"];
const AI_PANEL = [["resize"], ["history"], ["transcript"], ["context chip", "scope"]];

const CASES = [
  {
    id: "count-bugs",
    what: "answers from the backlog without writing",
    turns: [{
      text: "How many bugs are still open (not done or cancelled)? List their keys.",
      check: ({ text, diff, keyOf }) => ({ count: /\b3\b|three/i.test(text), keys: BUGS.every((t) => text.includes(keyOf(t))), noWrites: diff.quiet })
    }]
  },
  {
    id: "file-bug",
    what: "files one well-formed ticket, then edits it in a follow-up",
    turns: [
      {
        text: "File a bug: exporting a board to CSV drops the Due column. It's high priority.",
        check: ({ diff }) => {
          const made = diff.created;
          return { oneTicket: made.length === 1, title: /csv/i.test(made[0]?.title ?? ""), priority: (made[0]?.priority ?? 0) >= 3, bugLabel: !!made[0]?.labels.includes("bug") };
        }
      },
      {
        text: "Put it under the Multi-board architecture epic.",
        check: ({ diff, now, byTitle, run }) => {
          const ticket = now.find((i) => /csv/i.test(i.title) && !run.seeded.has(i.id));
          return { parent: !!ticket && ticket.parentId === byTitle("Multi-board architecture")?.id, noNewTickets: diff.created.length === 0 };
        }
      }
    ]
  },
  {
    id: "duplicate",
    what: "notices the ask is already a ticket instead of filing a second",
    turns: [{
      text: "Add a ticket so list_items can filter by board.",
      check: ({ text, diff, keyOf }) => ({ noDuplicate: diff.created.length === 0, pointsAtExisting: text.includes(keyOf("tomrade.list_items: accept a boardId filter")) })
    }]
  },
  {
    id: "move",
    what: "finds a ticket by description and changes only it",
    turns: [{
      text: "I'm starting on the matcha theme switcher ticket — move it to Doing.",
      check: ({ diff, byTitle }) => ({ status: byTitle("Add matcha to ThemePreference")?.status === "doing", onlyThat: diff.changed.length === 1 && diff.created.length === 0 })
    }]
  },
  {
    id: "breakdown",
    what: "splits a ticket into linked children",
    turns: [{
      text: "Break 'Command palette over boards, views, issues and actions' down into 3 to 5 smaller tickets.",
      check: ({ diff, byTitle }) => {
        const palette = byTitle("Command palette over boards");
        const linked = diff.created.filter((i) => i.parentId === palette?.id || palette?.blocks.includes(i.id) || palette?.blockedBy.includes(i.id) || i.blocks.includes(palette?.id) || (palette?.parentId && i.parentId === palette.parentId));
        return { count: diff.created.length >= 3 && diff.created.length <= 5, linked: diff.created.length > 0 && linked.length === diff.created.length };
      }
    }]
  },
  {
    id: "recall",
    what: "keeps context across turns",
    turns: [
      { text: "Which ticket is about the undo toast?", check: ({ text, keyOf, diff }) => ({ key: text.includes(keyOf("Undo toast with an inline action")), noWrites: diff.quiet }) },
      { text: "Raise its priority to urgent.", check: ({ byTitle, diff }) => ({ priority: byTitle("Undo toast with an inline action")?.priority === 4, onlyThat: diff.changed.length === 1 }) }
    ]
  },
  {
    id: "summary",
    what: "summarises an epic from its tickets",
    turns: [{
      text: "Give me a two or three sentence status of the AI panel epic.",
      check: ({ text, diff }) => ({ coverage: AI_PANEL.filter((words) => words.some((w) => has(text, w))).length >= 2, brief: text.split(/\s+/).length <= 160, noWrites: diff.quiet })
    }]
  }
].filter((c) => !env.TOMRADE_EVAL_CASES || env.TOMRADE_EVAL_CASES.split(",").includes(c.id));

const Judged = z.object({ score: z.number().min(1).max(5), reason: z.string() });

async function main() {
  const { ctx } = await boot({
    configFile: path.join(dir, "../tomrade.yml"),
    vars: { userData: work, locale: "en-US" },
    // The parts are run directly, so each is the thread's engine and not chosen for it.
    patches: [[{ id: "mcp", config: { port: 0 } }, { id: "hub-cloud", disabled: true }, { id: "attention", config: { notify: false } }, { id: "engine-tomrade", disabled: true }]]
  });
  ctx.hub.configure(path.join(work, "hub"));
  await ctx.storage.ready;
  const settings = ctx.settings.get();
  const engineOptions = JSON.parse(env.TOMRADE_EVAL_ENGINES ?? "{}");

  let profile = null;
  if (arms.some((a) => a === "loop" || a === "pi-builtin") || judging) {
    const preset = env.TOMRADE_EVAL_PRESET;
    if (!preset) throw new Error("Set TOMRADE_EVAL_PRESET for loop, pi-builtin or the judge (e.g. openai)");
    const known = PROVIDERS.find((p) => p.id === preset);
    if (!known) throw new Error(`Unknown TOMRADE_EVAL_PRESET ${preset}; one of ${PROVIDERS.map((p) => p.id).join(", ")}`);
    const apiKey = env.TOMRADE_EVAL_API_KEY ?? (known.env ? env[known.env] : undefined);
    if (env.TOMRADE_EVAL_MODEL) {
      // A named model is used as given, as a person would set it in Settings → Models.
      const models = ctx.settings.get().models;
      profile = { id: "eval", title: known.title, provider: known.provider, ...(known.baseURL ? { baseURL: known.baseURL } : {}), apiKey: apiKey ?? "", model: env.TOMRADE_EVAL_MODEL };
      ctx.settings.set({ ...ctx.settings.get(), models: { ...models, profiles: [profile] } });
    } else {
      const setup = await ctx.llm.quickSetup({ preset, apiKey });
      if (!setup.ok) throw new Error(`Model setup failed: ${setup.kind} ${setup.detail}`);
      profile = ctx.settings.get().models.profiles.find((p) => p.id === setup.profile.id);
    }
    for (const id of ["loop", "pi-builtin"]) engineOptions[id] = { profile: profile.id, ...(env.TOMRADE_EVAL_EFFORT ? { effort: env.TOMRADE_EVAL_EFFORT } : {}), ...engineOptions[id] };
  }
  ctx.settings.set({ ...ctx.settings.get(), language: "en", agent: { ...ctx.agent.settingsOf(), engines: { ...ctx.agent.settingsOf().engines, ...engineOptions } } });

  const version = (cmd) => { try { return execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 10_000 }).trim(); } catch { return null; } };
  const manifest = {
    schemaVersion: 1, startedAt: new Date().toISOString(), arms, reps, timeoutMs, judging,
    cases: CASES.map((c) => ({ id: c.id, what: c.what, turns: c.turns.map((t) => t.text) })),
    model: profile ? { provider: profile.provider, baseURL: profile.baseURL ?? null, model: profile.model } : null,
    engineOptions, claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
    versions: { claude: version("claude"), codex: version("codex"), node: process.version, electron: process.versions.electron },
    skipped: {},
    notes: [
      "Each run seeds a fresh sample project; arms rotate order every repetition.",
      "Turn 1 of a case is a cold start for agents with a runtime pool, later turns are warm.",
      "loop and pi-builtin share one model; Claude Code and Codex use the model their own sign-in gives.",
      "costUsd is what the engine reports; subscription engines report an estimate or nothing.",
      "The judge is the same model as loop and pi-builtin, so it may favour them; read it beside the checks."
    ]
  };

  const ready = [];
  for (const arm of arms) {
    const engine = ctx.agent.engineOf(arm);
    const state = engine ? await engine.available({ fresh: true }).catch((e) => ({ ok: false, reason: String(e) })) : { ok: false, reason: "not installed" };
    if (state.ok) ready.push(arm);
    else manifest.skipped[arm] = state.reason ?? state.need ?? "unavailable";
  }
  console.log(`engines: ${ready.join(", ") || "none"}${Object.keys(manifest.skipped).length ? ` · skipped ${JSON.stringify(manifest.skipped)}` : ""}`);

  const rows = [];
  fs.mkdirSync(out, { recursive: true });
  const flush = () => {
    const summary = summarize(rows, ready);
    fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ manifest, summary, rows }, null, 2));
    fs.writeFileSync(path.join(out, "report.md"), report(manifest, summary, rows, ready));
  };

  for (let rep = 0; rep < reps; rep++) {
    for (const c of CASES) {
      const order = ready.map((_, i) => ready[(i + rep) % ready.length]);
      for (const arm of order) {
        const seeded = seedDesignProject({ dbFor: (id) => ctx.db.for(id), items: ctx.items, projects: ctx.projects, boards: ctx.boards, views: ctx.views, fields: ctx.fields, gitRepos: ctx.repos });
        await ctx.storage.ready;
        const pid = seeded.project.id;
        const items = () => ctx.items.list({ projectId: pid });
        const run = { seeded: new Set(items().map((i) => i.id)) };
        const thread = ctx.agent.newThread(pid, arm);
        if (thread.engine !== arm) throw new Error(`asked for ${arm}, the thread got ${thread.engine}`);
        const transcript = [];
        for (const [turn, spec] of c.turns.entries()) {
          const before = new Map(items().map((i) => [i.id, i.version]));
          const { runId } = ctx.agent.send(pid, thread.id, { kind: "text", text: spec.text });
          const started = Date.now();
          let timedOut = false;
          while (["running"].includes(ctx.agent.store.run(pid, runId)?.status ?? "running")) {
            if (Date.now() - started > timeoutMs) { timedOut = true; ctx.agent.cancel(runId); await sleep(2000); break; }
            await sleep(250);
          }
          const view = ctx.agent.store.run(pid, runId);
          const blocks = ctx.agent.store.messages(pid, thread.id).filter((m) => m.runId === runId);
          const text = blocks.filter((m) => m.role === "agent" && m.block.type === "text").map((m) => m.block.text).join("\n");
          const firstText = blocks.find((m) => m.role === "agent" && m.block.type === "text");
          const traces = blocks.filter((m) => m.block.type === "trace").map((m) => m.block);
          const now = items();
          const created = now.filter((i) => !before.has(i.id));
          const changed = now.filter((i) => before.has(i.id) && before.get(i.id) !== i.version);
          const byTitle = (prefix) => now.find((i) => i.title.startsWith(prefix));
          const keyOf = (prefix) => byTitle(prefix)?.key ?? "\u0000";
          let checks;
          try {
            checks = spec.check({ text, diff: { created, changed, quiet: !created.length && !changed.length }, now, byTitle, keyOf, run });
          } catch (e) {
            checks = { checkThrew: false };
            console.log(`  check failed: ${e}`);
          }
          transcript.push({ user: spec.text, agent: text, created: created.map((i) => `${i.key} ${i.title}`), changed: changed.map((i) => `${i.key} ${i.title}`) });
          const elapsedMs = view?.endedAt ? view.endedAt - view.startedAt : Date.now() - started;
          const row = {
            arm, caseId: c.id, rep, turn, runtime: view?.metrics?.runtime ?? (turn === 0 ? "cold" : "warm"),
            status: timedOut ? "timeout" : view?.status ?? "missing", stop: view?.stop ?? null, error: view?.error ?? null,
            pass: !timedOut && (view?.status === "done" || view?.status === "asked") && Object.values(checks).every(Boolean), checks,
            elapsedMs, firstTextMs: view?.metrics?.firstTokenMs ?? (firstText && view ? firstText.at - view.startedAt : null),
            toolCalls: view?.metrics?.toolCalls ?? traces.length, toolFailures: traces.filter((t) => !t.ok).length,
            tools: traces.map((t) => ({ tool: t.tool, ok: t.ok, args: JSON.stringify(t.args ?? null).slice(0, 300), summary: String(t.summary ?? "").slice(0, 200) })),
            inputTokens: view?.usage?.inputTokens ?? null, outputTokens: view?.usage?.outputTokens ?? null,
            uncachedInputTokens: view?.tokens?.uncachedInputTokens ?? null,
            cacheReadTokens: view?.tokens?.cacheReadTokens ?? view?.metrics?.cacheReadTokens ?? null,
            cacheWriteTokens: view?.tokens?.cacheWriteTokens ?? view?.metrics?.cacheWriteTokens ?? null,
            costUsd: view?.costUsd ?? null, changes: view?.changes ?? null, providerModel: view?.metrics?.providerModel ?? null,
            created: created.map((i) => ({ key: i.key, title: i.title, parent: now.find((p) => p.id === i.parentId)?.key ?? i.parentId })),
            changed: changed.map((i) => ({ key: i.key, title: i.title, status: i.status, priority: i.priority, parent: now.find((p) => p.id === i.parentId)?.key ?? i.parentId })),
            text, judge: null
          };
          if (judging && text) row.judge = await judge(ctx, c, transcript).catch((e) => ({ score: null, reason: String(e) }));
          rows.push(row);
          console.log(`${row.pass ? "PASS" : "FAIL"} ${arm} ${c.id}#${rep}.${turn} ${(elapsedMs / 1000).toFixed(1)}s ${row.inputTokens ?? "?"}→${row.outputTokens ?? "?"} tok${row.judge?.score ? ` judge ${row.judge.score}` : ""} ${JSON.stringify(checks)}${row.error ? ` · ${row.error.slice(0, 160)}` : ""}`);
          flush();
          if (row.status !== "done") break;
        }
      }
    }
  }
  flush();
  console.log(`\nReport: ${path.join(out, "report.md")}`);
}

async function judge(ctx, c, transcript) {
  const conversation = transcript.map((t) => `USER: ${t.user}\nAGENT: ${t.agent}\n(backlog changes — created: ${t.created.join("; ") || "none"}; changed: ${t.changed.join("; ") || "none"})`).join("\n\n");
  return ctx.llm.completeJson(Judged, {
    system: "You grade an assistant that manages a software backlog. Score its LAST reply 1–5: 5 = correct, complete, concise and clear; 3 = usable with flaws; 1 = wrong or unhelpful. Judge by what it did to the backlog as well as what it said. Reply as JSON {\"score\": n, \"reason\": \"one sentence\"}.",
    user: `Task: ${c.what}.\n\n${conversation}`,
    temperature: 0,
    maxTokens: 400
  });
}

const pct = (values, p) => {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.ceil(p * v.length) - 1)] : null;
};
const mean = (values) => {
  const v = values.filter((x) => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
const sd = (values) => {
  const v = values.filter((x) => typeof x === "number");
  const m = mean(v);
  return v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / (v.length - 1)) : null;
};

function summarize(rows, arms) {
  return arms.map((arm) => {
    const mine = rows.filter((r) => r.arm === arm);
    const cold = mine.filter((r) => r.turn === 0);
    const warm = mine.filter((r) => r.turn > 0);
    const caseRuns = new Map();
    for (const r of mine) {
      const key = `${r.caseId}#${r.rep}`;
      caseRuns.set(key, (caseRuns.get(key) ?? true) && r.pass);
    }
    const byCase = {};
    for (const r of mine) {
      byCase[r.caseId] ??= { passed: 0, runs: 0 };
    }
    for (const [key, ok] of caseRuns) {
      const id = key.split("#")[0];
      byCase[id].runs++;
      if (ok) byCase[id].passed++;
    }
    const elapsed = mine.map((r) => r.elapsedMs);
    return {
      arm, turns: mine.length,
      quality: {
        turnPassRate: mine.length ? mine.filter((r) => r.pass).length / mine.length : null,
        casePassRate: caseRuns.size ? [...caseRuns.values()].filter(Boolean).length / caseRuns.size : null,
        byCase,
        judgeMean: mean(mine.map((r) => r.judge?.score))
      },
      time: {
        coldP50Ms: pct(cold.map((r) => r.elapsedMs), 0.5), coldP95Ms: pct(cold.map((r) => r.elapsedMs), 0.95),
        warmP50Ms: pct(warm.map((r) => r.elapsedMs), 0.5), warmP95Ms: pct(warm.map((r) => r.elapsedMs), 0.95),
        firstTextP50Ms: pct(mine.map((r) => r.firstTextMs), 0.5),
        elapsedCv: mean(elapsed) ? sd(elapsed) / mean(elapsed) : null
      },
      tokens: {
        inputMean: mean(mine.map((r) => r.inputTokens)), outputMean: mean(mine.map((r) => r.outputTokens)),
        cacheReadMean: mean(mine.map((r) => r.cacheReadTokens)), cacheWriteMean: mean(mine.map((r) => r.cacheWriteTokens)),
        costUsdTotal: mine.some((r) => r.costUsd !== null) ? mine.reduce((a, r) => a + (r.costUsd ?? 0), 0) : null,
        toolCallsMean: mean(mine.map((r) => r.toolCalls))
      },
      stability: {
        errors: mine.filter((r) => r.status === "error").length,
        timeouts: mine.filter((r) => r.status === "timeout").length,
        asked: mine.filter((r) => r.status === "asked").length,
        toolFailureRate: mine.reduce((a, r) => a + r.toolCalls, 0) ? mine.reduce((a, r) => a + r.toolFailures, 0) / mine.reduce((a, r) => a + r.toolCalls, 0) : null,
        // A case that passed in one repetition and failed in another.
        flakyCases: Object.entries(byCase).filter(([, v]) => v.passed > 0 && v.passed < v.runs).map(([id]) => id)
      }
    };
  });
}

function report(manifest, summary, rows, arms) {
  const s = (ms) => (ms === null ? "–" : `${(ms / 1000).toFixed(1)}s`);
  const n = (x, d = 0) => (x === null || x === undefined ? "–" : Number(x).toFixed(d));
  const p = (x) => (x === null ? "–" : `${Math.round(x * 100)}%`);
  const lines = [
    `# Backlog engines — ${manifest.startedAt}`,
    "",
    `Model for loop / pi-builtin: ${manifest.model ? `${manifest.model.model} (${manifest.model.baseURL ?? manifest.model.provider})` : "–"} · repetitions ${manifest.reps} · judge ${manifest.judging ? "on" : "off"}`,
    ...(Object.keys(manifest.skipped).length ? [`Skipped: ${Object.entries(manifest.skipped).map(([a, r]) => `${a} (${r})`).join(", ")}`] : []),
    "",
    "| engine | cases passed | turns passed | judge | cold p50 / p95 | warm p50 / p95 | first text p50 | time CV | input tok | output tok | cache read | tools / turn | cost | errors | timeouts | flaky |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.map((a) => `| ${a.arm} | ${p(a.quality.casePassRate)} | ${p(a.quality.turnPassRate)} | ${n(a.quality.judgeMean, 1)} | ${s(a.time.coldP50Ms)} / ${s(a.time.coldP95Ms)} | ${s(a.time.warmP50Ms)} / ${s(a.time.warmP95Ms)} | ${s(a.time.firstTextP50Ms)} | ${n(a.time.elapsedCv, 2)} | ${n(a.tokens.inputMean)} | ${n(a.tokens.outputMean)} | ${n(a.tokens.cacheReadMean)} | ${n(a.tokens.toolCallsMean, 1)} | ${a.tokens.costUsdTotal === null ? "–" : `$${a.tokens.costUsdTotal.toFixed(3)}`} | ${a.stability.errors} | ${a.stability.timeouts} | ${a.stability.flakyCases.join(", ") || "–"} |`),
    "",
    "## Cases",
    "",
    `| case | ${arms.join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|`,
    ...manifest.cases.map((c) => `| ${c.id} — ${c.what} | ${summary.map((a) => (a.quality.byCase[c.id] ? `${a.quality.byCase[c.id].passed}/${a.quality.byCase[c.id].runs}` : "–")).join(" | ")} |`),
    "",
    "## Failed turns",
    "",
    ...rows.filter((r) => !r.pass).map((r) => `- **${r.arm}** ${r.caseId}#${r.rep}.${r.turn} (${r.status}): ${Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k).join(", ") || r.error || "stopped"}${r.text ? ` — “${r.text.replace(/\s+/g, " ").slice(0, 200)}”` : ""}`),
    "",
    ...manifest.notes.map((note) => `> ${note}`)
  ];
  return lines.join("\n") + "\n";
}

app.whenReady().then(async () => {
  let code = 0;
  try {
    await main();
  } catch (error) {
    console.error(error);
    code = 1;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
    app.exit(code);
  }
});
