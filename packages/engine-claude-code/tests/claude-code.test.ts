import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent, type RunView } from "@tomradex/agent";
import { Mcp } from "@tomradex/mcp";
import engineClaudeCode, { claudeSignedIn, lineSplitter } from "@tomradex/engine-claude-code";

const FAKE = `#!/bin/bash
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/args.txt"
echo '{"type":"system","subtype":"init","session_id":"sess-1"}'
echo '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hello "}}}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"hello from claude code"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok","session_id":"sess-1","total_cost_usd":0.0123,"usage":{"input_tokens":10,"output_tokens":5}}'
`;

async function settled(ctx: Context, projectId: string, runId: string, timeout = 8000): Promise<RunView> {
  const t0 = Date.now();
  for (;;) {
    const run = ctx.agent.store.run(projectId, runId);
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
      JSON.stringify({ agent: { defaultEngine: "claude-code", confirmWritesOver: 0, engines: { "claude-code": { transport: "cli", command: bin, model: "opus", effort: "high" } } } })
    );

    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();

    const thread = ctx.agent.newThread(project.id, "claude-code");
    const first = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hello" });
    const run1 = await settled(ctx, project.id, first.runId);
    expect(run1.status).toBe("done");
    expect(run1.costUsd).toBeCloseTo(0.0123);
    expect(run1.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
    expect(blocks.some((b) => b.type === "text" && b.text === "hello from claude code")).toBe(true);

    const args1 = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(args1).toContain("--output-format");
    expect(args1).toContain("mcp__tomrade__*");
    expect(args1).toContain("dontAsk");
    expect(args1).toContain("--model\nopus");
    expect(args1).toContain("--effort\nhigh");
    expect(args1).not.toContain("--resume");

    const second = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
    await settled(ctx, project.id, second.runId);
    const args2 = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(args2).toContain("--resume");
    expect(args2).toContain("sess-1");

    const codeThread = ctx.agent.newThread(project.id, "claude-code", null, {
      itemId: "ticket-1",
      branch: "tom-1/code-task"
    });
    ctx.on("agent/prepare-turn", (input) => {
      input.env = { TOMRADE_ENV_TEST: "passed" };
    });
    fs.writeFileSync(bin, FAKE.replace('dir="$(dirname "$0")"', 'dir="$(dirname "$0")"\ntest "$TOMRADE_ENV_TEST" = "passed" || exit 1'), { mode: 0o755 });
    const codeRun = ctx.agent.send(project.id, codeThread.id, { kind: "text", text: "implement it" });
    expect((await settled(ctx, project.id, codeRun.runId)).status).toBe("done");
    const codeArgs = fs.readFileSync(path.join(dir, "args.txt"), "utf8");
    expect(codeArgs).not.toContain("--strict-mcp-config");
    expect(codeArgs).toContain("--permission-mode\nauto");
    expect(codeArgs).not.toContain("--max-turns");
  });
});

describe("whether Claude Code is signed in", () => {
  it("says no only for a first-party account that `claude auth status` reports logged out", () => {
    expect(claudeSignedIn('{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty"}')).toBe(true);
    expect(claudeSignedIn('{"loggedIn": false, "apiProvider": "firstParty"}\n')).toBe(false);
    expect(claudeSignedIn('{"loggedIn": false}')).toBe(false);
    // Bedrock, Vertex and the like are signed in some other way; a version without the subcommand prints no JSON.
    expect(claudeSignedIn('{"loggedIn": false, "apiProvider": "bedrock"}')).toBeNull();
    expect(claudeSignedIn("error: unknown command 'auth'")).toBeNull();
  });
});

it("splits records on LF only, across chunk boundaries", () => {
  const lines: string[] = [];
  const push = lineSplitter((line) => lines.push(line));
  const text = JSON.stringify({ a: "x\u2028y" }) + "\r\n" + JSON.stringify({ b: "é" }) + "\n";
  const bytes = Buffer.from(text);
  push(bytes.subarray(0, 5)); push(bytes.subarray(5, bytes.length - 3)); push(bytes.subarray(bytes.length - 3));
  expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: "x\u2028y" }, { b: "é" }]);
});
