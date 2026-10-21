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
import engineClaudeCode, { claudeSignedIn, lineSplitter, runJsonl } from "@tomradex/engine-claude-code";

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
  it("ignores a saved cli transport, runs through the SDK with the picked model and effort, and opens coding threads unrestricted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
    const log = path.join(dir, "requests.jsonl");
    const bin = path.join(dir, "claude");
    const fake = path.resolve("packages/engine-claude-code/tests/fake-claude.mjs");
    fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ agent: { defaultEngine: "claude-code", confirmWritesOver: 0, engines: { "claude-code": { transport: "cli", command: bin, model: "opus", effort: "high" } } } })
    );

    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineClaudeCode] });
    await settle();
    const spawns = () => fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((r) => r.spawn);
    try {
      const thread = ctx.agent.newThread(project.id, "claude-code");
      const first = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hello" });
      const run1 = await settled(ctx, project.id, first.runId);
      expect(run1.status, run1.error ?? undefined).toBe("done");
      expect(run1.costUsd).toBeCloseTo(0.02);
      expect(run1.usage).toEqual({ inputTokens: 34, outputTokens: 3 });
      const blocks = ctx.agent.store.messages(project.id, thread.id).map((m) => m.block);
      expect(blocks.some((b) => b.type === "text" && b.text === "hello")).toBe(true);

      const args1 = spawns()[0].args.join("\n");
      expect(args1).toContain("--input-format\nstream-json");
      expect(args1).toContain("mcp__tomrade__*");
      expect(args1).toContain("--strict-mcp-config");
      expect(args1).toContain("--model\nopus");
      expect(args1).toContain("--effort\nhigh");
      expect(args1).not.toContain("--resume");

      const second = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
      expect((await settled(ctx, project.id, second.runId)).status).toBe("done");
      expect(spawns()).toHaveLength(1);

      const codeThread = ctx.agent.newThread(project.id, "claude-code", null, {
        itemId: "ticket-1",
        branch: "tom-1/code-task"
      });
      ctx.on("agent/prepare-turn", (input) => {
        input.env = { TOMRADE_ENV_TEST: "passed" };
      });
      const codeRun = ctx.agent.send(project.id, codeThread.id, { kind: "text", text: "implement it" });
      expect((await settled(ctx, project.id, codeRun.runId)).status).toBe("done");
      const code = spawns().at(-1);
      expect(code.envTest).toBe("passed");
      const codeArgs = code.args.join("\n");
      expect(codeArgs).not.toContain("--strict-mcp-config");
      expect(codeArgs).toContain("--permission-mode\nbypassPermissions");
      expect(codeArgs).not.toContain("--max-turns");
    } finally {
      await ctx.fiber.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

it("reads a JSON line with U+2028 in a string as one event", async () => {
  const events: Record<string, unknown>[] = [];
  const node = { file: process.execPath, argv: (args: string[]) => ({ command: process.execPath, args }), env: (base = process.env) => base };
  const script = 'process.stdout.write(JSON.stringify({ text: "a\\u2028b\\u2029c" }) + "\\n")';
  const { done } = runJsonl(node, ["-e", script], { cwd: os.tmpdir(), signal: new AbortController().signal, onLine: (event) => events.push(event) });
  expect((await done).code).toBe(0);
  expect(events).toEqual([{ text: "a\u2028b\u2029c" }]);
});
