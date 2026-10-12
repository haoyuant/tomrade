import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, PANEL_SURFACES, type CardView, type ChecklistCard, type FindingCard, type RunView } from "@tomradex/agent";
import { Doctor, KnownIssue, before, fingerprint, matches, scrub } from "@tomradex/doctor";

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `tomrade-doctor-${name}-`));

async function settled(ctx: Context, projectId: string, runId: string, timeout = 8000): Promise<RunView> {
  const t0 = Date.now();
  for (;;) {
    const run = ctx.agent.store.run(projectId, runId);
    if (run && run.status !== "running") return run;
    if (Date.now() - t0 > timeout) throw new Error("run did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function boot() {
  const dataDir = tmp("data");
  const logDir = tmp("logs");
  fs.writeFileSync(path.join(logDir, "tomrade-2026-10-12.log"), "2026-10-12T00:00:00Z INFO  [boot] up\n2026-10-12T00:00:01Z ERROR [mcp] failed with key sk-ant-abcdefghijklmnop\n");
  const base = await fresh({ plugins: [Tools, [Settings, { path: path.join(tmp("settings"), "settings.json") }], Agent, [Doctor, { dataDir, logDir, version: "0.6.0" }]] });
  await settle();
  const ctx = base.ctx;
  const agentLog = path.join(tmp("acme"), "acme.log");
  fs.writeFileSync(agentLog, `request to copilot.tencent.com for ${os.homedir()}/work by someone@example.com\n401 Unauthorized\n`);
  let calls = 0;
  ctx.agent.engine({
    id: "acme",
    title: "Acme",
    author: "ai:acme",
    available: async () => ({ ok: true, cli: { state: "ready", path: "/usr/local/bin/acme", version: "2.1", source: "path", attempts: [], searched: [], platform: "darwin", arch: "arm64", pathEnv: "" } }),
    setup: { install: ["npm i -g acme"], signIn: "acme login" },
    diagnostics: { logs: () => [agentLog], facts: () => ({ edition: "ioa" }) },
    async turn() {
      calls++;
      return { stop: "error", error: "Acme stopped: Request failed with status code 401", details: "── answer ──\n{\"statusCode\":401,\"model\":\"hy3-ioa\"}" };
    }
  });
  return { ...base, ctx, dataDir, calls: () => calls };
}

const cardsOf = (ctx: Context, projectId: string, threadId: string): CardView[] => ctx.agent.thread(projectId, threadId).cards;

describe("known issues", () => {
  const issue = KnownIssue.parse({
    id: "acme-ioa", engine: "acme", when: [{ fact: "edition", matches: "^ioa$" }, { text: "-ioa\\b" }],
    title: { en: "Internal edition", zh: "内部版" }, explain: { en: "x", zh: "x" }, confidence: "medium", offer: ["retry-with"]
  });

  it("match a fact or a pattern in the error, only for their engine", () => {
    expect(matches(issue, { engineId: "acme", texts: [], facts: { edition: "ioa" }, version: "0.6.0" })).toBe(true);
    expect(matches(issue, { engineId: "acme", texts: ["model hy3-ioa refused"], facts: {}, version: "0.6.0" })).toBe(true);
    expect(matches(issue, { engineId: "other", texts: ["model hy3-ioa refused"], facts: { edition: "ioa" }, version: "0.6.0" })).toBe(false);
    expect(matches(issue, { engineId: "acme", texts: ["timeout"], facts: { edition: "public" }, version: "0.6.0" })).toBe(false);
  });

  it("stop matching from the release that fixed them", () => {
    const fixed = { ...issue, fixedIn: "0.7.0" };
    expect(matches(fixed, { engineId: "acme", texts: [], facts: { edition: "ioa" }, version: "v0.6.3" })).toBe(true);
    expect(matches(fixed, { engineId: "acme", texts: [], facts: { edition: "ioa" }, version: "0.7.0" })).toBe(false);
    expect(before("0.10.0", "0.9.9")).toBe(false);
  });

  it("are data: a malformed entry is refused, a bad pattern never matches", () => {
    expect(() => KnownIssue.parse({ ...issue, id: "Bad Id" })).toThrow();
    expect(() => KnownIssue.parse({ ...issue, offer: ["rm -rf"] })).toThrow();
    expect(matches({ ...issue, when: [{ text: "(" }] }, { engineId: "acme", texts: ["("], facts: {}, version: "1" })).toBe(false);
  });
});

describe("evidence", () => {
  it("never carries a key, the home folder's name or an email address", () => {
    const out = scrub("key sk-ant-abcdefghijklmnop in /Users/alice/x by alice.smith@corp.example.com", "/Users/alice");
    expect(out).not.toMatch(/abcdefghijklmnop|alice\.smith|corp\.example|\/Users\/alice/);
    expect(out).toContain("~/x");
  });

  it("fingerprints the same failure alike across people", () => {
    expect(fingerprint("acme", "timeout after 30123 ms at /Users/a/x")).toBe(fingerprint("acme", "timeout after 999 ms at /home/b/y"));
    expect(fingerprint("acme", "timeout")).not.toBe(fingerprint("acme", "401"));
    expect(fingerprint("acme", "anything", "acme-ioa")).toBe("issue:acme-ioa");
  });
});

describe("the troubleshooter", () => {
  it("is an engine no picker offers", async () => {
    const { ctx } = await boot();
    const view = (await ctx.agent.engineViews()).find((e) => e.id === "doctor");
    expect(view?.capabilities).toEqual([]);
  });

  it("looks into a failed turn: checks, a test turn in a hidden thread, the known issue, what to do", async () => {
    const { ctx, project, calls } = await boot();
    ctx.doctor.issue({
      id: "acme-ioa", engine: "acme", when: [{ fact: "edition", matches: "^ioa$" }],
      title: { en: "Acme is the internal edition", zh: "内部版" }, explain: { en: "Carry on with another agent.", zh: "先换个智能体。" }, confidence: "medium", offer: ["retry-with"]
    });
    const failing = ctx.agent.newThread(project.id, "acme");
    await settled(ctx, project.id, ctx.agent.send(project.id, failing.id, { kind: "text", text: "hello" }).runId);

    const thread = ctx.doctor.start(project.id, { threadId: failing.id });
    expect(thread.surface).toBe("doctor");
    expect(ctx.agent.store.threads(project.id, PANEL_SURFACES).map((t) => t.id)).toContain(thread.id);
    const run = ctx.agent.store.runs(project.id, thread.id)[0]!;
    expect((await settled(ctx, project.id, run.id, 15_000)).status).toBe("done");

    expect(calls()).toBe(2);
    expect(ctx.agent.store.threads(project.id, null).some((t) => t.surface === "probe")).toBe(false);
    const cards = cardsOf(ctx, project.id, thread.id);
    const checklist = cards.find((c) => c.schema === "checklist")!.data as ChecklistCard;
    expect(checklist.rows.map((r) => [r.id, r.state])).toEqual([["app", "ok"], ["engine:acme", "ok"], ["mcp", "fail"], ["probe", "fail"]]);
    expect(checklist.rows.find((r) => r.id === "probe")?.line).toContain("401");

    const findings = ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "card" && m.block.schema === "finding" ? [m.block.data as FindingCard] : []));
    expect(findings[0]?.headline).toBe("Acme is the internal edition");
    expect(findings[0]?.actions).toContainEqual(expect.objectContaining({ kind: "retry-with", threadId: failing.id, exclude: "acme" }));
    expect(findings.at(-1)?.actions.map((a) => a.kind)).toEqual(expect.arrayContaining(["say", "report"]));
  });

  it("writes a report the person reads before it goes: no conversation unless asked", async () => {
    const { ctx, project } = await boot();
    const failing = ctx.agent.newThread(project.id, "acme");
    await settled(ctx, project.id, ctx.agent.send(project.id, failing.id, { kind: "text", text: "my secret plan" }).runId);
    const thread = ctx.doctor.start(project.id, { threadId: failing.id });
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);

    const report = ctx.doctor.report(project.id, thread.id);
    const text = report.sections.map((s) => s.text).join("\n");
    expect(report.sections.map((s) => s.id)).toEqual(["error", "checks", "environment", "logs"]);
    expect(text).toContain("status code 401");
    expect(text).toContain("edition: ioa");
    expect(text).toContain("401 Unauthorized");
    expect(text).not.toMatch(/my secret plan|abcdefghijklmnop|someone@example|\/Users\//);
    expect(report.engine).toBe("acme");
    expect(report.app.version).toBe("0.6.0");

    const withChat = ctx.doctor.report(project.id, thread.id, { conversation: true }, "It broke after the update");
    expect(withChat.sections[0]).toMatchObject({ id: "note", text: "It broke after the update" });
    expect(withChat.sections.find((s) => s.id === "conversation")?.text).toContain("my secret plan");
  });

  it("keeps a report it could not deliver, and sends it later", async () => {
    const { ctx, project, dataDir } = await boot();
    const thread = ctx.doctor.start(project.id, null);
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);

    const delivered: string[] = [];
    ctx.doctor.transport = async () => { throw new Error("fetch failed"); };
    const queued = await ctx.doctor.send(project.id, thread.id);
    expect(queued).toMatchObject({ state: "queued", reason: "fetch failed" });
    expect(ctx.doctor.pending()).toBe(1);

    ctx.doctor.transport = async (report) => { delivered.push(report.code); };
    expect(await ctx.doctor.flush()).toBe(1);
    expect(delivered).toEqual([queued.code]);
    expect(ctx.doctor.pending()).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, "sent.json"), "utf8"))[0].code).toBe(queued.code);
  });

  it("with nothing failed, checks the whole setup and says what is missing", async () => {
    const { ctx, project, calls } = await boot();
    const thread = ctx.doctor.start(project.id, null);
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);
    const checklist = cardsOf(ctx, project.id, thread.id).find((c) => c.schema === "checklist")!.data as ChecklistCard;
    expect(checklist.rows.map((r) => r.id)).toEqual(["app", "engine:acme", "models", "mcp", "sync"]);
    expect(calls()).toBe(0);
    const models = checklist.rows.find((r) => r.id === "models");
    expect(models?.state).toBe("warn");
  });
});
