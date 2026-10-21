/** An engine given in the flat shape plugins built before the grouping still send is read in the grouped one. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, flatEngineView, normalizeEngine, type Engine, type EngineRegistration } from "@tomradex/agent";

const base = { id: "e", title: "E", author: "ai:e" as const, available: async () => ({ ok: true }), turn: async () => ({ stop: "end" as const }) };
const grouped = (flat: Record<string, unknown>) => normalizeEngine({ ...base, ...flat } as EngineRegistration);

describe("normalizeEngine", () => {
  // Each flat combination registered in this repository or in tomrade-plugins, and what it means now.
  it.each([
    ["nothing said (Claude Code, Codex, Pi)", {}, { mode: "handoff" }],
    ["terminal: false (Tomrade, built-in Pi, the troubleshooter, an ACP agent without a terminal)", { terminal: false }, { mode: "none" }],
    ["terminal: true (dsh, Gemini CLI, OpenCode)", { terminal: true }, { mode: "handoff" }],
    ["terminal + terminalViaLink (Hermes)", { terminal: true, terminalViaLink: true }, { mode: "handoff", via: "link" }],
    ["terminalOnly (a CLI that only runs in a terminal)", { terminalOnly: true }, { mode: "only" }],
    ["terminalOnly + terminalViaLink + terminalClaims (Cursor, Antigravity)", { terminalOnly: true, terminalViaLink: true, terminalClaims: true }, { mode: "only", via: "link", claims: true }]
  ])("%s", (_name, flat, terminal) => {
    const engine = grouped(flat);
    // Absent is `handoff`, as it was.
    expect(engine.terminal ?? { mode: "handoff" }).toEqual(terminal);
    for (const key of ["terminalOnly", "terminalViaLink", "terminalClaims"]) expect(key in engine).toBe(false);
  });

  it("reads steers as the queue protocol, and no steers as none", () => {
    expect(grouped({ steers: true }).steering).toBe("queue");
    expect(grouped({ terminal: false, steers: true })).toMatchObject({ terminal: { mode: "none" }, steering: "queue" });
    expect(grouped({ steers: false }).steering).toBeUndefined();
    expect("steers" in grouped({ steers: true })).toBe(false);
  });

  it("groups the local agent's members under local", () => {
    const picks = () => [{ key: "model", title: "Model", choices: [] }];
    const checkCli = async (file: string) => ({ ok: true, path: file });
    const mcpLink = { status: async () => ({ state: "missing" as const, url: null, configuredUrl: null, file: null, manual: { connect: "", disconnect: "" } }), connect: async () => ({} as never), disconnect: async () => ({} as never) };
    const setup = { install: ["npm i -g e"], signIn: "e login" };
    const diagnostics = { logs: () => ["/tmp/e.log"] };
    const commands = { check: async () => ({ state: "allowed" as const, why: "bypass" as const, mode: "full" }) };
    const engine = grouped({ picks, checkCli, mcpLink, setup, diagnostics, commands });
    expect(engine.local).toEqual({ picks, checkCli, mcpLink, setup, diagnostics, commands });
    for (const key of ["picks", "checkCli", "mcpLink", "setup", "diagnostics", "commands"]) expect(key in engine).toBe(false);
  });

  it("leaves an engine in the grouped shape as it is", () => {
    const engine: Engine = { ...base, terminal: { mode: "only", via: "link" }, steering: "forward", local: { setup: { install: [] } } };
    expect(normalizeEngine(engine)).toBe(engine);
  });

  it("keeps a getter live", () => {
    let title = "One";
    const engine = normalizeEngine({ ...base, get title() { return title; }, terminal: false } as EngineRegistration);
    title = "Two";
    expect(engine.title).toBe("Two");
  });

  it("is what the agent registers, and what its views and plugin scenarios read back", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-engine-shape-"));
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Agent, { mediaDir: path.join(root, "media") }]] });
    try {
      ctx.agent.engine({ ...base, id: "flat", capabilities: ["code"], terminalOnly: true, terminalViaLink: true, terminalClaims: true, steers: true, picks: () => [{ key: "model", title: "Model", choices: [], freeText: true }] });
      const engine = ctx.agent.engineOf("flat")!;
      expect(engine).toMatchObject({ terminal: { mode: "only", via: "link", claims: true }, steering: "queue" });
      expect(engine.local?.picks?.()).toEqual([{ key: "model", title: "Model", choices: [], freeText: true }]);
      expect((await ctx.agent.engineViews()).find((e) => e.id === "flat")).toMatchObject({ terminalOnly: true, steers: true, picks: [{ key: "model" }] });
      expect(flatEngineView(engine)).toMatchObject({ terminalOnly: true, terminalViaLink: true, terminalClaims: true, steers: true, picks: [{ key: "model" }], mcpLink: false, options: false });
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("flatEngineView", () => {
  it("says the terminal in the flat names a scenario reads", () => {
    expect(flatEngineView(grouped({ terminal: false }))).toMatchObject({ terminal: false });
    expect(flatEngineView(grouped({ terminal: true, terminalViaLink: true, steers: true }))).toMatchObject({ terminal: true, terminalViaLink: true, steers: true });
    expect(flatEngineView(grouped({}))).not.toHaveProperty("steers");
  });
});
