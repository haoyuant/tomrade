import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { describe, expect, it } from "vitest";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { TurnIO, TurnInput } from "@tomradex/agent";
import { createCodexEngine } from "../src/index.js";

/** Opt-in: the real `codex app-server` with the user's own login. TOMRADE_LIVE_CODEX=1 pnpm test */
describe.skipIf(!process.env.TOMRADE_LIVE_CODEX)("live Codex", () => {
  it("takes a message sent mid-turn into the running turn", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-live-"));
    const ctx = new Context();
    await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
    const engine = createCodexEngine(ctx);
    const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, messages: [], cards: [], brief: null, pending: null, options: {},
      input: { kind: "text", text: "Run the shell command `sleep 8 && echo finished`, then tell me in one short sentence what it printed." } };
    const order: string[] = [];
    let forward: ((steer: { id: string; text: string }) => Promise<boolean>) | undefined;
    let running = false;
    const io: TurnIO = { emit: (block) => order.push(block.type === "text" ? `agent:${block.text}` : block.type), delta() {}, progress() {}, signal: new AbortController().signal,
      activity: (label) => { if (label) running = true; },
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId: "thread", projectId: "project", author: "ai:codex", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() },
      steerTo: (fn) => { forward = fn; }, steered: (id) => order.push(`steered:${id}`) };
    try {
      const turn = engine.turn(input, io);
      const t0 = Date.now();
      while (!running && Date.now() - t0 < 90_000) await new Promise((r) => setTimeout(r, 200));
      expect(running).toBe(true);
      expect(await forward!({ id: "s1", text: "Change of plan: reply in French, and start your sentence with BONJOUR." })).toBe(true);
      const result = await turn;
      console.log(JSON.stringify(order));
      expect(result.stop, result.error).toBe("end");
      const steeredAt = order.indexOf("steered:s1");
      expect(steeredAt).toBeGreaterThanOrEqual(0);
      expect(order.slice(steeredAt).some((line) => /BONJOUR/i.test(line))).toBe(true);
    } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 180_000);
});
