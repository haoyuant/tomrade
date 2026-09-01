import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";
import { Settings } from "@tomrade/settings";
import { Agent, type RunView } from "@tomrade/agent";
import { Mcp } from "@tomrade/mcp";
import engineClaudeCode from "@tomrade/engine-claude-code";

const FAKE = `#!/bin/bash
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/args.txt"
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from claude code"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-1","total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5}}'
`;

async function settled(ctx: Context, runId: string, timeout = 8000): Promise<RunView> {
  const t0 = Date.now();
  for (;;) {
    const run = ctx.agent.store.run(runId);
    if (run && run.status !== "running") return run;
    if (Date.now() - t0 > timeout) throw new Error("run did not settle");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("the Claude Code engine", () => {
  it("maps stream-json to blocks, passes the picked model and effort, and resumes with the session id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
    const bin = path.join(dir, "claude.sh");
    fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ agent: { defaultEngine: "claude-code", confirmWritesOver: 0, engines: { "claude-code": { command: bin, model: "opus", effort: "high" } } } })
    );

    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();

    const thread = ctx.agent.newThread(project.id, "claude-code");
    const first = ctx.agent.send(thread.id, { kind: "text", text: "hello" });
    const run1 = await settled(ctx, first.runId);
    expect(run1.status).toBe("done");
    expect(run1.costUsd).toBeCloseTo(0.0123);
    expect(run1.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const blocks = ctx.agent.store.messages(thread.id).map((m) => m.block);
    expect(blocks.some((b) => b.type === "text" && b.text === "hello from claude code")).toBe(true);

    const args1 = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(args1).toContain("--output-format");
    expect(args1).toContain("mcp__tomrade__*");
    expect(args1).toContain("dontAsk");
    expect(args1).toContain("--model\nopus");
    expect(args1).toContain("--effort\nhigh");
    expect(args1).not.toContain("--resume");

    const second = ctx.agent.send(thread.id, { kind: "text", text: "again" });
    await settled(ctx, second.runId);
    const args2 = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(args2).toContain("--resume");
    expect(args2).toContain("sess-1");
  });
});
