import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";
import { Settings } from "@tomrade/settings";
import { FakeChatModel, fakeChat } from "@tomrade/llm";
import { Agent, loadPlaybookDir, resolvePlaybook, missingPlaybookCapabilities } from "@tomrade/agent";
import engineLoop from "@tomrade/engine-loop";

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
    expect(system).toContain("acme.review — the user asks for a review");
    await base.ctx.fiber.dispose();
  });
});
