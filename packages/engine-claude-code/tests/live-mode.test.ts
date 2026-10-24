import { expect, it, vi } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { TurnInput, TurnIO } from "@tomradex/agent";
import { createClaudeCodeEngine } from "../src/index.js";

const capture = vi.hoisted(() => ({ modes: [] as string[], decisions: [] as string[], asking: null as null | (() => void) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Options }) => ({
    close() {},
    async setPermissionMode(mode: string) { capture.modes.push(mode); },
    async *[Symbol.asyncIterator]() {
      yield { type: "system", subtype: "init", session_id: "session", model: "m", permissionMode: options.permissionMode };
      const asked = options.canUseTool!("Bash", { command: "npm test" }, { signal: new AbortController().signal, toolUseID: "tool" });
      capture.asking?.();
      capture.decisions.push((await asked)!.behavior);
      yield { type: "result", subtype: "success", is_error: false, session_id: "session", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } };
    }
  })
}));

it("takes a mode picked mid-turn, and lets through the call that was waiting for the person", async () => {
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const engine = createClaudeCodeEngine(ctx);
    expect(engine.liveModes).toBe(true);
    const turn: TurnInput = { threadId: "thread", projectId: "project", purpose: "code", permissionMode: "default", input: { kind: "text", text: "implement" }, messages: [], cards: [], brief: null, pending: null, options: { command: process.execPath } };
    let apply: ((mode: string) => Promise<boolean>) | undefined;
    const notes: string[] = [];
    const io: TurnIO = { emit(block) { if (block.type === "note") notes.push(block.text); }, delta() {}, progress() {}, signal: new AbortController().signal,
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId: "thread", projectId: "project", author: "ai:claude-code", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() },
      modeTo: (fn) => { apply = fn; },
      // the person never answers: only the mode can settle it
      requestPermission: (_text, _options, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(null), { once: true }))
    };
    capture.asking = () => {
      void (async () => {
        expect(await apply!("local")).toBe(false);
        expect(await apply!("bypassPermissions")).toBe(true);
      })();
    };
    expect((await engine.turn(turn, io)).stop).toBe("end");
    expect(capture.modes).toEqual(["bypassPermissions"]);
    expect(capture.decisions).toEqual(["allow"]);
    expect(notes.some((note) => note.includes("Allowed without asking"))).toBe(true);
  } finally { await ctx.fiber.dispose(); }
});
