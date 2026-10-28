import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { Context } from "cordis";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Agent, generalPrompt, type TurnInput } from "@tomradex/agent";

async function boot() {
  const artifact = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-rules-"));
  const fakeStorage = { name: "fake-storage", apply(ctx: Context) { ctx.provide("storage", { artifactDirFor: () => artifact }); } };
  const f = await fresh({ plugins: [Tools, [Settings, { path: path.join(artifact, "settings.json") }], fakeStorage, Agent] });
  await settle();
  const seen: TurnInput[] = [];
  f.ctx.agent.engine({ id: "listen", title: "Listener", author: "ai:test", available: async () => ({ ok: true }),
    async turn(input) {
      seen.push(input);
      return { stop: "end" };
    } });
  const settled = async (threadId: string, n: number) => {
    for (let i = 0; i < 500; i++) {
      const runs = f.ctx.agent.store.runs(f.project.id, threadId);
      if (runs.length === n && runs.every((r) => r.status !== "running")) return;
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("runs never settled");
  };
  return { ...f, artifact, seen, settled };
}

it("keeps the rules in the project's folder and hands them to every turn", async () => {
  const t = await boot();
  try {
    expect(t.ctx.agent.rules(t.project.id)).toBeNull();
    t.ctx.agent.setRules(t.project.id, "- Write tickets in Chinese\r\n- Never touch billing\n\n");
    expect(fs.readFileSync(path.join(t.artifact, "rules.md"), "utf8")).toBe("- Write tickets in Chinese\n- Never touch billing\n");
    const thread = t.ctx.agent.newThread(t.project.id, "listen");
    t.ctx.agent.send(t.project.id, thread.id, { kind: "text", text: "plan the week" });
    await t.settled(thread.id, 1);
    expect(t.seen[0]?.rules).toBe("- Write tickets in Chinese\n- Never touch billing");

    // edited by hand in the folder: the next turn reads that
    fs.writeFileSync(path.join(t.artifact, "rules.md"), "- Reply in English\n");
    t.ctx.agent.send(t.project.id, thread.id, { kind: "text", text: "again" });
    await t.settled(thread.id, 2);
    expect(t.seen[1]?.rules).toBe("- Reply in English");

    expect(() => t.ctx.agent.setRules(t.project.id, "x".repeat(8001))).toThrow(/8000/);
    t.ctx.agent.setRules(t.project.id, "   ");
    expect(fs.existsSync(path.join(t.artifact, "rules.md"))).toBe(false);
    t.ctx.agent.send(t.project.id, thread.id, { kind: "text", text: "and without" });
    await t.settled(thread.id, 3);
    expect(t.seen[2]?.rules).toBeUndefined();
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("adds a proposed rule only once the person says yes", async () => {
  const t = await boot();
  try {
    t.ctx.agent.setRules(t.project.id, "- Keep tickets small");
    const propose = (answer: string | null | undefined) =>
      t.ctx.tools.execute("propose_rule", { rule: "  - Always write tickets in Chinese " }, { by: "ai:test", projectId: t.project.id, ...(answer === undefined ? {} : { ask: async () => answer }) });
    expect(await propose("Don't add")).toMatchObject({ added: false });
    expect(t.ctx.agent.rules(t.project.id)).toBe("- Keep tickets small");
    expect(await propose("Add rule")).toMatchObject({ added: true });
    expect(t.ctx.agent.rules(t.project.id)).toBe("- Keep tickets small\n- Always write tickets in Chinese");
    await expect(propose(undefined)).rejects.toThrow(/Project settings → Rules/);
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("takes the project from the call when the connection names none", async () => {
  const t = await boot();
  try {
    const unbound = { by: "ai:mcp" };
    await expect(t.ctx.tools.execute("propose_rule", { rule: "Test with the cheap model" }, unbound)).rejects.toThrow(/projectId: required here/);
    // Nobody here to ask: the agent asks the user itself and passes their yes.
    await expect(t.ctx.tools.execute("propose_rule", { projectId: t.project.id, rule: "Test with the cheap model" }, unbound)).rejects.toThrow(/userSaid/);
    expect(t.ctx.agent.rules(t.project.id)).toBeNull();
    expect(await t.ctx.tools.execute("propose_rule", { projectId: t.project.id, rule: "Test with the cheap model", userSaid: "yes, add it" }, unbound)).toMatchObject({ added: true });
    expect(t.ctx.agent.rules(t.project.id)).toBe("- Test with the cheap model");
    // Where Tomrade can ask, it still asks, whatever the agent passed.
    expect(await t.ctx.tools.execute("propose_rule", { projectId: t.project.id, rule: "Never touch billing", userSaid: "yes" }, { ...unbound, ask: async () => "Don't add" })).toMatchObject({ added: false });
    expect(t.ctx.agent.rules(t.project.id)).toBe("- Test with the cheap model");
  } finally {
    await t.ctx.fiber.dispose();
  }
});

it("puts the rules in a terminal agent's brief", () => {
  const prompt = generalPrompt({ ticket: { key: "AL-1", title: "Weekly report" }, cwd: "/tmp/x", playbook: { id: "document.write", source: "plugin", digest: "d", body: "Write it." }, continued: false, rules: "- Reply in Chinese" });
  expect(prompt).toContain("Project rules — the person set these for every agent working in this project");
  expect(prompt).toContain("- Reply in Chinese");
});
