import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, PANEL_SURFACES, type CardView, type ChecklistCard, type FindingCard, type RunView } from "@tomradex/agent";
import { Doctor, KnownIssue, before, fingerprint, matches, parseCatalog, scrub, type RemoteReport, type Report } from "@tomradex/doctor";

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
    expect(before("dev", "0.7.0")).toBe(true);
    expect(before("1.2", "1.2.1")).toBe(true);
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
  it("takes an engine and its error from setup as the topic, and the row carries the last test message", async () => {
    const { ctx, project } = await boot();
    // The remembered test message (TOM-503): the fake turn errors, so the try fails.
    const tried = await ctx.agent.tryEngine(project.id, "acme");
    expect(tried.ok).toBe(false);
    const thread = ctx.doctor.start(project.id, { engineId: "acme", error: tried.error ?? "" });
    expect(thread.title).toContain("Acme");
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);
    expect(ctx.doctor.latest(thread.id)?.topic).toMatchObject({ engineId: "acme", error: expect.stringContaining("401") });
    const checklist = cardsOf(ctx, project.id, thread.id).find((c) => c.schema === "checklist")!.data as ChecklistCard;
    const row = checklist.rows.find((r) => r.id === "engine:acme");
    expect(row).toMatchObject({ state: "warn", line: expect.stringContaining("test message failed") });
  });

  it("says a ready agent answered its test message once it did", async () => {
    const { ctx, project } = await boot();
    ctx.agent.engine({
      id: "fine",
      title: "Fine",
      author: "ai:fine",
      available: async () => ({ ok: true }),
      async turn(_input, io) {
        io.emit({ type: "text", text: "pong" });
        return { stop: "end" };
      }
    });
    await ctx.agent.tryEngine(project.id, "fine");
    const thread = ctx.doctor.start(project.id, null);
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);
    const checklist = cardsOf(ctx, project.id, thread.id).find((c) => c.schema === "checklist")!.data as ChecklistCard;
    expect(checklist.rows.find((r) => r.id === "engine:fine")).toMatchObject({ state: "ok", line: expect.stringContaining("answered a test message") });
  });

  it("reads the account's sync status, an object, into its row and facts", async () => {
    const { ctx, project } = await boot();
    ctx.provide("cloudHub", { info: () => ({ user: { id: "u", email: "a@b.co" }, status: { state: "error", location: "a@b.co", lastSyncAt: null, detail: "fetch failed" }, pending: 2 }) } as never);
    const thread = ctx.doctor.start(project.id, null);
    const run = await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);
    expect(run.status).not.toBe("failed");
    const sync = (cardsOf(ctx, project.id, thread.id).find((c) => c.schema === "checklist")!.data as ChecklistCard).rows.find((r) => r.id === "sync");
    expect(sync).toMatchObject({ state: "warn", line: expect.stringContaining("error (fetch failed)") });
    expect(ctx.doctor.latest(thread.id)?.facts.sync).toBe("error");
  });
});

describe("an agent looking into it", () => {
  it("is another ready agent, briefed with the evidence, held to the troubleshooting tools, and its conclusion becomes a card", async () => {
    const { ctx, project } = await boot();
    const seen: { text: string; tools: string[]; only?: boolean; resume?: string; refused?: string; sources?: unknown }[] = [];
    ctx.agent.engine({
      id: "helper",
      title: "Helper",
      author: "ai:helper",
      available: async () => ({ ok: true }),
      async turn(input, io) {
        const entry: (typeof seen)[number] = { text: input.input.kind === "text" ? input.input.text : "", tools: io.tools.describe().map((t) => t.name), only: io.tools.only, resume: io.resume };
        seen.push(entry);
        entry.sources = await io.tools.execute("doctor_read_log", {});
        await io.tools.execute("list_items", {}).catch((error: Error) => { entry.refused = error.message; });
        if (seen.length === 1) {
          await io.tools.execute("doctor_conclude", { headline: "Acme signs in against the wrong endpoint", explanation: "Its internal edition needs the internal environment.", confidence: "medium", offer: ["retry-with", "sign-in"] });
        }
        io.emit({ type: "text", text: "Here is what I found." });
        return { stop: "end", resume: "session-1" };
      }
    });
    const failing = ctx.agent.newThread(project.id, "acme");
    await settled(ctx, project.id, ctx.agent.send(project.id, failing.id, { kind: "text", text: "hello" }).runId);
    const thread = ctx.doctor.start(project.id, { threadId: failing.id });
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);

    const cards = () => ctx.agent.store.messages(project.id, thread.id).flatMap((m) => (m.block.type === "card" && m.block.schema === "finding" ? [m.block.data as FindingCard] : []));
    const offer = cards().at(-1)!.actions.find((a) => a.kind === "investigate");
    expect(offer).toMatchObject({ kind: "investigate", engineIds: ["helper"] });

    ctx.doctor.investigate(project.id, thread.id, "helper");
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id).at(-1)!.id, 15_000);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toContain("status code 401");
    expect(seen[0]!.text).toContain("edition: ioa");
    expect(seen[0]!.text).toContain("Helper, please look into this.");
    expect(seen[0]!.text).not.toContain(os.homedir());
    expect(seen[0]!.tools.every((name) => ["doctor_read_log", "doctor_check_again", "doctor_conclude", "ask_user", "web_search", "web_fetch"].includes(name))).toBe(true);
    expect(seen[0]!.tools).toContain("doctor_conclude");
    // No tool of the engine's own either (the loop's make_media).
    expect(seen[0]!.only).toBe(true);
    expect(seen[0]!.refused).toMatch(/not available while troubleshooting/);
    expect(seen[0]!.sources).toEqual({ sources: expect.arrayContaining(["acme/acme.log"]) });

    const conclusion = cards().at(-1)!;
    expect(conclusion).toMatchObject({ headline: "Acme signs in against the wrong endpoint", confidence: "medium" });
    expect(conclusion.actions.map((a) => a.kind)).toEqual(["retry-with", "sign-in", "report"]);
    expect(ctx.agent.store.thread(project.id, thread.id)?.options).toMatchObject({ investigator: "helper" });
    expect(ctx.doctor.report(project.id, thread.id).sections.find((s) => s.id === "checks")?.text).toContain("Acme signs in against the wrong endpoint");

    // The person answers: the same agent carries on in its own session, without the brief again.
    await settled(ctx, project.id, ctx.agent.send(project.id, thread.id, { kind: "text", text: "It is the internal edition." }).runId, 15_000);
    expect(seen).toHaveLength(2);
    expect(seen[1]!.resume).toBe("session-1");
    expect(seen[1]!.text).toBe("It is the internal edition.");
  });

  it("keeps its tools out of every other conversation", async () => {
    const { ctx, project } = await boot();
    let listed: string[] = [];
    ctx.agent.engine({ id: "plain", title: "Plain", author: "ai:plain", available: async () => ({ ok: true }), async turn(_input, io) { listed = io.tools.describe().map((t) => t.name); return { stop: "end" }; } });
    const thread = ctx.agent.newThread(project.id, "plain");
    await settled(ctx, project.id, ctx.agent.send(project.id, thread.id, { kind: "text", text: "hi" }).runId);
    expect(listed).toContain("ask_user");
    expect(listed.filter((name) => name.startsWith("doctor_"))).toEqual([]);
  });

  it("never runs its tools outside a troubleshooting conversation", async () => {
    const { ctx } = await boot();
    await expect(ctx.tools.execute("doctor_read_log", {}, { by: "ai:mcp" })).rejects.toThrow(/only inside a troubleshooting conversation/);
  });
});

describe("the catalog from tomrade.com", () => {
  const entry = { id: "acme-quota", engine: "acme", when: [{ text: "quota" }], title: { en: "Out of quota", zh: "额度用完" }, explain: { en: "x", zh: "x" }, confidence: "high", offer: ["settings"] };

  it("keeps the well-formed entries and drops the rest, never the whole file", () => {
    expect(parseCatalog({ version: 1, issues: [entry, { ...entry, id: "Bad" }, { ...entry, id: "acme-run", offer: ["rm -rf /"] }, 42] }).map((i) => i.id)).toEqual(["acme-quota"]);
    expect(parseCatalog({ version: 2, issues: [entry] })).toEqual([]);
    expect(parseCatalog("<html>")).toEqual([]);
  });

  it("adds to what was bundled, with its newer word on the same id, and keeps its cache when tomrade.com can't be reached", async () => {
    const { ctx } = await boot();
    const newer = { ...entry, id: "workbuddy-ioa-edition", engine: "workbuddy", title: { en: "Newer wording", zh: "新的说法" } };
    const ok = (async () => new Response(JSON.stringify({ version: 1, issues: [entry, newer] }), { status: 200 })) as unknown as typeof fetch;
    expect(await ctx.doctor.refreshCatalog(true, ok)).toBe(2);
    const ids = ctx.doctor.issues().map((i) => i.id);
    expect(ids).toContain("acme-quota");
    expect(ids.filter((id) => id === "workbuddy-ioa-edition")).toHaveLength(1);
    expect(ctx.doctor.issues().find((i) => i.id === "workbuddy-ioa-edition")?.title.en).toBe("Newer wording");
    const down = (async () => { throw new Error("fetch failed"); }) as unknown as typeof fetch;
    expect(await ctx.doctor.refreshCatalog(true, down)).toBe(2);
    expect(ctx.doctor.issues().map((i) => i.id)).toContain("acme-quota");
  });
});

describe("my reports", () => {
  it("lists what waits, what went and what came back; a reply is new until seen, and new again when it changes", async () => {
    const { ctx, project } = await boot();
    const thread = ctx.doctor.start(project.id, null);
    await settled(ctx, project.id, ctx.agent.store.runs(project.id, thread.id)[0]!.id, 15_000);
    ctx.doctor.transport = async () => { throw new Error("offline"); };
    const waiting = await ctx.doctor.send(project.id, thread.id);
    ctx.doctor.transport = async () => {};
    const sent = await ctx.doctor.send(project.id, thread.id);
    let remote: RemoteReport[] = [{ code: sent.code, created_at: new Date().toISOString(), summary: "Models: no model connected", engine: null, status: "fixed", reply: "Fixed — update to 0.7.0.", replied_at: "2026-10-12T10:00:00Z", fixed_in: "0.7.0" }];
    ctx.doctor.fetchReports = async () => remote;

    const first = await ctx.doctor.reports();
    expect(first.reports.map((r) => [r.code, r.status])).toEqual(expect.arrayContaining([[waiting.code, "queued"], [sent.code, "fixed"]]));
    expect(first.unread).toBe(1);
    const fixed = first.reports.find((r) => r.code === sent.code)!;
    expect(fixed).toMatchObject({ reply: "Fixed — update to 0.7.0.", fixedIn: "0.7.0", fixedHere: false, unread: true });

    await ctx.doctor.markRead();
    expect((await ctx.doctor.reports()).unread).toBe(0);
    remote = [{ ...remote[0]!, reply: "Also: sign in again after updating.", replied_at: "2026-10-13T10:00:00Z" }];
    expect((await ctx.doctor.reports()).unread).toBe(1);

    await ctx.doctor.deleteReport(waiting.code);
    expect((await ctx.doctor.reports()).reports.some((r) => r.code === waiting.code)).toBe(false);
    expect(ctx.doctor.pending()).toBe(0);
  });

  it("takes feedback and ideas the way it takes reports: only what was written, kept until sent, listed by kind", async () => {
    const { ctx } = await boot();
    const preview = ctx.doctor.feedbackReport("idea", "  Group the board by assignee.\nMy key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz  ");
    expect(preview).toMatchObject({ kind: "idea", engine: null, summary: "Group the board by assignee." });
    expect(preview.fingerprint).toMatch(/^idea:[0-9a-f]{12}$/);
    expect(preview.sections).toHaveLength(1);
    expect(preview.sections[0]!.text).not.toContain("abcdefghijklmnop");
    expect(() => ctx.doctor.feedbackReport("idea", "  ")).toThrow();
    expect(() => ctx.doctor.feedbackReport("rant" as never, "x")).toThrow();

    const delivered: Report[] = [];
    ctx.doctor.transport = async () => { throw new Error("offline"); };
    const waiting = await ctx.doctor.sendFeedback("feedback", "The board is too bright.");
    expect(waiting.state).toBe("queued");
    ctx.doctor.transport = async (report) => void delivered.push(report);
    expect(await ctx.doctor.flush()).toBe(1);
    expect(delivered.map((r) => r.kind)).toEqual(["feedback"]);
    ctx.doctor.fetchReports = async () => [];
    expect((await ctx.doctor.reports()).reports.find((r) => r.code === waiting.code)).toMatchObject({ kind: "feedback", status: "sent" });
  });
});
