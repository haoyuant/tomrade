import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { FakeChatModel, fakeChat, type CompletionRequest, type LlmService } from "@tomradex/llm";
import { Agent, loadPlaybookDir, resolvePlaybook, missingPlaybookCapabilities } from "@tomradex/agent";
import engineLoop from "@tomradex/engine-loop";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-playbooks-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
const tmp = (name: string) => {
  const dir = path.join(root, `${name}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

function skillMd(dir: string, name: string, body: string, meta: { title?: string; description?: string; tools?: string[] } = {}): void {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  const tools = meta.tools?.length ? `\ntools:\n${meta.tools.map((t) => `  - ${t}`).join("\n")}` : "";
  fs.writeFileSync(path.join(folder, "SKILL.md"), `---\nname: ${name}\ntitle: ${meta.title ?? name}\ndescription: ${meta.description ?? "when testing"}${tools}\n---\n\n${body}\n`);
}

const tmpSettings = () => [Settings, { path: path.join(root, `settings-${n++}.json`) }] as const;

async function boot(opts: { playbooksDir?: string; storageDir?: string } = {}) {
  const fakeStorage = {
    name: "fake-storage",
    apply(ctx: Context) {
      ctx.provide("storage", { artifactDirFor: async () => opts.storageDir ?? null });
    }
  };
  const base = await fresh({
    plugins: [Tools, [...tmpSettings()], fakeChat(new FakeChatModel([{ text: "ok" }])), [Agent, { playbooksDir: opts.playbooksDir }], engineLoop, ...(opts.storageDir ? [fakeStorage] : [])]
  });
  await settle();
  return { ...base, agent: base.ctx.agent };
}

describe("loadPlaybookDir", () => {
  it("preserves selected prerequisites without treating recommendations as restrictions", () => {
    const resolved = resolvePlaybook({
      plugin: { id: "document.write", title: "Write", when: "a document is needed", tools: [], body: "Draft", requires: ["files.write"] },
      project: { id: "document.write", title: "Project writing", when: "a document is needed", tools: [], body: "Draft and review", workTypes: ["general"], requires: ["files.write", "sources.read"], optionalCapabilities: ["document.preview"], outputs: ["document"] }
    });
    expect(resolved?.entry).toMatchObject({ source: "project", workTypes: ["general"], outputs: ["document"], requires: ["files.write", "sources.read"] });
    expect(missingPlaybookCapabilities(resolved!.winner, ["sources.read"])).toEqual(["files.write"]);
    expect(missingPlaybookCapabilities(resolved!.winner, ["sources.read", "files.write"])).toEqual([]);
    expect(missingPlaybookCapabilities({}, [])).toEqual([]);
  });
  it("reads SKILL.md frontmatter and body", () => {
    const dir = tmp("skills");
    skillMd(dir, "acme.review", "1. Look closely.", { title: "Review", description: "the user asks for a review", tools: ["list_items", "ask_user"] });
    fs.mkdirSync(path.join(dir, "no-skill-here"));
    const loaded = loadPlaybookDir(dir);
    expect(loaded).toEqual([
      { id: "acme.review", title: "Review", when: "the user asks for a review", tools: ["list_items", "ask_user"], body: "1. Look closely." }
    ]);
    expect(loadPlaybookDir(path.join(dir, "missing"))).toEqual([]);
  });
  it("reads a SKILL.md saved with Windows line endings as the same playbook", () => {
    const dir = tmp("skills-crlf");
    fs.mkdirSync(path.join(dir, "acme.review"));
    const text = ["---", "name: acme.review", "title: Review", "description: the user asks for a review", "tools: [list_items, ask_user]", "---", "1. Look closely.", ""].join("\r\n");
    fs.writeFileSync(path.join(dir, "acme.review", "SKILL.md"), text);
    expect(loadPlaybookDir(dir)).toEqual([{ id: "acme.review", title: "Review", when: "the user asks for a review", tools: ["list_items", "ask_user"], body: "1. Look closely." }]);
  });
});

describe("playbook sources", () => {
  it("recommends a playbook when an agent creates a ticket through create_item", async () => {
    const base = await fresh({
      plugins: [Tools, [...tmpSettings()], fakeChat(new FakeChatModel([]), () => ({ workType: "general", playbookId: "document.write", confidence: 0.9, reason: "document" })), [Agent, {}], engineLoop]
    });
    await settle();
    const created = await base.ctx.tools.execute("create_item", { title: "Write the project guide" }, { by: "ai:loop", projectId: base.project.id });
    expect(created).toMatchObject({ workType: "general", playbookId: "document.write" });
    await base.ctx.fiber.dispose();
  });

  it("a budgeted recommendation answers from keywords when the worker model hangs, and says so in the log", async () => {
    const requests: CompletionRequest[] = [];
    // Never answers and ignores its signal.
    const hung = { name: "hung-llm", apply(ctx: Context) { ctx.provide("llm", { worker: async () => ({ ok: true, via: "profile", title: "hung" }), completeJson: (_schema: unknown, request: CompletionRequest) => (requests.push(request), new Promise(() => {})) } as unknown as LlmService); } };
    const base = await fresh({ plugins: [Tools, [...tmpSettings()], hung, [Agent, {}], engineLoop] });
    await settle();
    const warnings: string[] = [];
    const spy = vi.spyOn(base.ctx.logger, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
    const started = Date.now();
    const recommendation = await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Write the project guide" }, { withinMs: 50 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(recommendation).toMatchObject({ source: "fallback", playbookId: "document.write" });
    expect(requests[0]).toMatchObject({ maxTokens: 400, repair: false });
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    expect(warnings.join("\n")).toMatch(/fell back to keywords after \d+ms: no answer within 50ms/);
    spy.mockRestore();
    await base.ctx.fiber.dispose();
  });

  it("a budgeted recommendation does not wait on a playbook refresh that hangs", async () => {
    const base = await fresh({
      plugins: [Tools, [...tmpSettings()], fakeChat(new FakeChatModel([]), () => ({ workType: "general", playbookId: "design.create", confidence: 0.9, reason: "design" })), [Agent, {}], engineLoop]
    });
    await settle();
    vi.spyOn(base.ctx.agent, "refreshProjectPlaybooks").mockReturnValue(new Promise(() => {}));
    const recommendation = await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Write the project guide", workType: "general" }, { withinMs: 50 });
    expect(recommendation).toMatchObject({ source: "fallback", playbookId: "document.write" });
    await base.ctx.fiber.dispose();
  });

  it("uses the worker model to recommend an applicable method and rejects out-of-scope answers", async () => {
    let response: unknown = { workType: "general", playbookId: "design.create", confidence: 0.94, reason: "The brief asks for visual design." };
    const base = await fresh({
      plugins: [Tools, [...tmpSettings()], fakeChat(new FakeChatModel([]), () => response), [Agent, {}], engineLoop]
    });
    await settle();
    const recommendation = await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Create a mobile app design", body: "Produce a visual prototype", workType: "general" });
    expect(recommendation).toMatchObject({ source: "llm", workType: "general", playbookId: "design.create", confidence: 0.94 });
    response = { workType: "general", playbookId: "document.write", confidence: 0.88, reason: "The brief is a document." };
    expect(await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Prepare a guide", body: "Write a document" })).toMatchObject({ workType: "general", playbookId: "document.write" });
    response = { workType: "coding", playbookId: "media.generate", confidence: 0.99, reason: "invalid" };
    const coding = await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Fix the API bug", workType: "coding" });
    expect(coding.workType).toBe("coding");
    expect(coding).toMatchObject({ source: "fallback" });
    expect(coding.playbookId).not.toBe("media.generate");
    await base.ctx.fiber.dispose();
  });

  /** Code changes and bug reports filed by an agent kept landing on design.create: code.implement was never offered. */
  describe("a coding ticket's method", () => {
    const codeLink = { name: "code-playbooks", inject: ["agent"], apply(ctx: Context) { for (const playbook of loadPlaybookDir(path.resolve("packages/code-link/playbooks"))) ctx.agent.playbook(playbook); } };
    const hung = (requests: CompletionRequest[] = []) => ({ name: "hung-llm", apply(ctx: Context) { ctx.provide("llm", { worker: async () => ({ ok: true, via: "profile", title: "hung" }), completeJson: (_schema: unknown, request: CompletionRequest) => (requests.push(request), new Promise(() => {})) } as unknown as LlmService); } });

    it("is code.implement from the keywords, for a coding ticket and a bug report alike, and a design ask keeps design.create", async () => {
      const base = await fresh({ plugins: [Tools, [...tmpSettings()], hung(), [Agent, {}], codeLink, engineLoop] });
      await settle();
      const recommend = (input: { title: string; body?: string; workType?: "coding" | "general" }) => base.ctx.agent.recommendPlaybook(base.project.id, input, { withinMs: 30 });
      expect(await recommend({ title: "Model adapters drop cached-input counts", workType: "coding" })).toMatchObject({ source: "fallback", playbookId: "code.implement" });
      expect(await recommend({ title: "Settings dialog UI misaligned on narrow windows", workType: "coding" })).toMatchObject({ playbookId: "code.implement" });
      expect(await recommend({ title: "CSV export bug: the header row is missing" })).toMatchObject({ workType: "coding", playbookId: "code.implement" });
      expect(await recommend({ title: "Design a new logo for the app" })).toMatchObject({ workType: "general", playbookId: "design.create" });
      await base.ctx.fiber.dispose();
    });

    it("is offered to the worker model, which may pick it", async () => {
      const asked: { candidates: { id: string }[] }[] = [];
      const base = await fresh({
        plugins: [Tools, [...tmpSettings()], fakeChat(new FakeChatModel([]), (_system, user) => (asked.push(JSON.parse(user)), { workType: "coding", playbookId: "code.implement", confidence: 0.9, reason: "a code change" })), [Agent, {}], codeLink, engineLoop]
      });
      await settle();
      expect(await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Playbook recommendation picks design.create", workType: "coding" })).toMatchObject({ source: "llm", playbookId: "code.implement" });
      expect(asked[0].candidates.map((c) => c.id)).toContain("code.implement");
      const created = await base.ctx.tools.execute("create_item", { title: "Fix the OpenAI max_tokens 400", workType: "coding" }, { by: "ai:claude-code", projectId: base.project.id });
      expect(created).toMatchObject({ workType: "coding", playbookId: "code.implement" });
      // never a general ticket's method
      await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Plan the offsite", workType: "general" });
      expect(asked.find((a) => (a as unknown as { title: string }).title === "Plan the offsite")!.candidates.map((c) => c.id)).not.toContain("code.implement");
      await base.ctx.fiber.dispose();
    });

    it("stops asking a worker model that missed three times running, and answers from the keywords without waiting", async () => {
      const requests: CompletionRequest[] = [];
      const base = await fresh({ plugins: [Tools, [...tmpSettings()], hung(requests), [Agent, {}], codeLink, engineLoop] });
      await settle();
      for (let i = 0; i < 3; i++) await base.ctx.agent.recommendPlaybook(base.project.id, { title: `Fix bug ${i}`, workType: "coding" }, { withinMs: 20 });
      expect(requests).toHaveLength(3);
      const started = Date.now();
      expect(await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Fix another bug", workType: "coding" }, { withinMs: 5_000 })).toMatchObject({ source: "fallback", playbookId: "code.implement" });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(requests).toHaveLength(3);
      // The keywords alone never ask it.
      expect(await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Write the guide" }, { keywordsOnly: true })).toMatchObject({ source: "fallback", workType: "general" });
      expect(requests).toHaveLength(3);
      await base.ctx.fiber.dispose();
    });

    it("is none, not a medium's, where code.implement is not installed", async () => {
      const base = await fresh({ plugins: [Tools, [...tmpSettings()], hung(), [Agent, {}], engineLoop] });
      await settle();
      expect(await base.ctx.agent.recommendPlaybook(base.project.id, { title: "Fix the API bug", workType: "coding" }, { withinMs: 30 })).toMatchObject({ source: "fallback", playbookId: null });
      await base.ctx.fiber.dispose();
    });
  });

  it("keeps a user SKILL.md and a plugin playbook with the same id — user wins by default", async () => {
    const dir = tmp("user-playbooks");
    skillMd(dir, "backlog.intake", "MY intake ritual.", { title: "My intake", description: "my own way" });
    const { ctx, agent } = await boot({ playbooksDir: dir });
    // The plugin registers the same id AFTER the user file loaded; nothing throws.
    agent.playbook({ id: "backlog.intake", title: "Requirement intake", when: "built-in way", body: "BUILT-IN intake." });
    agent.playbook({ id: "backlog.other", title: "Other", when: "something else", body: "other body" });

    const index = agent.playbookIndex();
    expect(index.map((e) => e.id)).toEqual(["backlog.intake", "backlog.other", "design.create", "document.write", "media.generate", "task.assist"]);
    expect(index[0]).toMatchObject({ source: "user", shadows: ["plugin"], title: "My intake" });
    expect(index[1]).toMatchObject({ source: "plugin", shadows: [] });
    expect(agent.openPlaybook("backlog.intake")).toBe("MY intake ritual.");
    await ctx.fiber.dispose();
  });

  it("a recorded choice flips the winner, and falls back when the chosen source is gone", async () => {
    const dir = tmp("user-playbooks");
    skillMd(dir, "backlog.intake", "MY intake ritual.");
    const { ctx, agent } = await boot({ playbooksDir: dir });
    agent.playbook({ id: "backlog.intake", title: "Requirement intake", when: "built-in way", body: "BUILT-IN intake." });

    const settings = ctx.settings.get();
    ctx.settings.set({ ...settings, agent: { defaultEngine: "loop", confirmWritesOver: 0, engines: {}, playbookChoices: { "backlog.intake": "plugin" } } });
    expect(agent.openPlaybook("backlog.intake")).toBe("BUILT-IN intake.");
    expect(agent.playbookIndex()[0]).toMatchObject({ source: "plugin", shadows: ["user"] });

    // A choice naming a source that is not present must not hide the playbook.
    ctx.settings.set({ ...settings, agent: { defaultEngine: "loop", confirmWritesOver: 0, engines: {}, playbookChoices: { "backlog.intake": "project" } } });
    expect(agent.openPlaybook("backlog.intake")).toBe("MY intake ritual.");
    await ctx.fiber.dispose();
  });

  it("two PLUGINS claiming one id still throws", async () => {
    const { ctx, agent } = await boot();
    agent.playbook({ id: "dup", title: "One", when: "w", body: "b" });
    expect(() => agent.playbook({ id: "dup", title: "Two", when: "w", body: "b" })).toThrow(/already registered/);
    await ctx.fiber.dispose();
  });

  it("reads project playbooks from the shared copy and lets them shadow everything", async () => {
    const artifact = tmp("artifact");
    skillMd(path.join(artifact, "playbooks"), "backlog.intake", "PROJECT intake ritual.", { description: "the project way" });
    const { ctx, agent, project } = await boot({ storageDir: artifact });
    agent.playbook({ id: "backlog.intake", title: "Requirement intake", when: "built-in way", body: "BUILT-IN intake." });

    await agent.refreshProjectPlaybooks(project.id);
    expect(agent.playbookIndex(project.id)[0]).toMatchObject({ source: "project", shadows: ["plugin"], when: "the project way" });
    expect(agent.openPlaybook("backlog.intake", project.id)).toBe("PROJECT intake ritual.");
    // Unscoped surfaces (the settings sheet) never see project variants.
    expect(agent.playbookIndex()[0]).toMatchObject({ source: "plugin", shadows: [] });
    await ctx.fiber.dispose();
  });
});

describe("the loop engine prompt", () => {
  it("carries the shared house rules and the playbook index", async () => {
    const model = new FakeChatModel([{ text: "hello" }]);
    const base = await fresh({ plugins: [Tools, [...tmpSettings()], fakeChat(model), [Agent, {}], engineLoop] });
    await settle();
    const agent = base.ctx.agent;
    agent.playbook({ id: "acme.review", title: "Review", when: "the user asks for a review", body: "look closely" });
    const thread = agent.newThread(base.project.id);
    const { runId } = agent.send(base.project.id, thread.id, { kind: "text", text: "hi" });
    for (let i = 0; i < 400 && agent.store.run(base.project.id, runId)?.status === "running"; i += 1) await new Promise((r) => setTimeout(r, 10));
    const system = model.requests[0].system ?? "";
    expect(system).toContain("House rules:");
    expect(system).toContain("Project code is written through a ticket");
    expect(system).toContain("acme.review — the user asks for a review");
    await base.ctx.fiber.dispose();
  });
});
