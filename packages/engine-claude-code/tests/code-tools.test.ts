import { expect, it, vi } from "vitest";
import { Context } from "cordis";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { TurnInput, TurnIO } from "@tomradex/agent";
import { createClaudeCodeEngine } from "../src/index.js";

const capture = vi.hoisted(() => ({ options: null as Options | null, decisions: [] as string[] }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: ({ options }: { options: Options }) => {
    capture.options = options;
    return {
      close() {},
      async *[Symbol.asyncIterator]() {
        if (options.canUseTool) {
          for (let i = 0; i < 3; i++) {
            const result = await options.canUseTool("Bash", { command: "npm test" }, { signal: new AbortController().signal, toolUseID: "tool" });
            capture.decisions.push(result!.behavior);
          }
        }
        yield { type: "result", subtype: "success", is_error: false, session_id: "session", total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } };
      }
    };
  }
}));

it.each(["code", "backlog"] as const)("exposes the full tool set and the person's permission policy for %s turns", async (purpose) => {
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  try {
    const engine = createClaudeCodeEngine(ctx);
    const turn: TurnInput = { threadId: "thread", projectId: "project", purpose, input: { kind: "text", text: "implement" }, messages: [], cards: [], brief: null, pending: null, options: { command: process.execPath } };
    const io: TurnIO = { emit() {}, delta() {}, progress() {}, signal: new AbortController().signal,
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId: "thread", projectId: "project", author: "ai:claude-code", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
    const choices = ["Allow once", "Deny", null];
    io.requestPermission = async () => choices.shift() ?? null;
    capture.decisions = [];
    expect((await engine.turn(turn, io)).stop).toBe("end");
    expect(capture.decisions).toEqual(["allow", "deny", "deny"]);
    const options = capture.options!;
    expect(options.tools).toEqual({ type: "preset", preset: "claude_code" });
    expect(options.strictMcpConfig).toBe(purpose !== "code");
    expect(options.settingSources).toEqual(["user", "project", "local"]);
    expect(options.maxTurns).toBe(purpose === "code" ? undefined : 24);
    const callback = options.hooks!.PreToolUse![0].hooks[0];
    const hook = async (tool_name: string) => {
      const result = await callback({ hook_event_name: "PreToolUse", tool_name, tool_input: {}, tool_use_id: "tool", session_id: "session", transcript_path: "", cwd: "" }, undefined, { signal: new AbortController().signal });
      return "hookSpecificOutput" in result && result.hookSpecificOutput?.hookEventName === "PreToolUse" ? result.hookSpecificOutput.permissionDecision : undefined;
    };
    for (const tool_name of ["Read", "Bash", "Glob", "Edit", "Write", "Agent", "Skill", "WebSearch", "mcp__local__lookup"]) {
      expect(await hook(tool_name)).toBeUndefined();
    }
    expect(options.permissionMode).toBeUndefined();
    expect(await hook("mcp__tomrade__get_item")).toBe("allow");
    if (purpose === "code") {
      for (const mode of ["auto", "bypassPermissions", "plan", "local"]) {
        turn.permissionMode = mode;
        await engine.turn(turn, io);
        expect(capture.options!.permissionMode).toBe(mode === "local" ? undefined : mode);
        expect(capture.options!.allowDangerouslySkipPermissions).toBe(mode === "bypassPermissions");
      }
    }

  } finally { await ctx.fiber.dispose(); }
});
