import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { collect, userMessage } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import engineCursor, { CURSOR_HOOK_COMMAND, cursorHookReader, cursorHookScript, cursorLentModel, cursorWorkerDir, cursorMcpFile, cursorSignedIn, hasCursorHooks, withCursorHooks, withMcpEntry } from "../src/index.js";
import { localCli } from "@tomradex/engine-claude-code";

const home = process.env.HOME;
afterEach(() => {
  process.env.HOME = home;
  delete process.env.FAKE_CURSOR_SIGNED_OUT;
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cursor-"));
  process.env.HOME = dir;
  const bin = path.join(dir, "cursor-agent");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-cursor/tests/fake-cursor-agent.mjs")}' "$@"\n`, { mode: 0o700 });
  const settingsPath = path.join(dir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ agent: { engines: { cursor: { command: bin, model: "gpt-5" } } } }));
  const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineCursor] });
  await settle();
  return { ctx, dir, engine: ctx.agent.engineOf("cursor")! };
}

describe("Cursor as an engine", () => {
  it("is offered for a terminal only, reached through its own config, and claims first", async () => {
    const { ctx, engine } = await setup();
    try {
      expect(engine).toMatchObject({ title: "Cursor", capabilities: ["code", "general"], terminalOnly: true, terminalViaLink: true, terminalClaims: true });
      expect(engine.setup?.install[0]).toContain("cursor.com/install");
      expect(await engine.available({ fresh: true })).toMatchObject({ ok: true });
      expect(await engine.turn({} as never, {} as never)).toMatchObject({ stop: "error", error: expect.stringContaining("only in a terminal") });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("says, without failing, that it needs signing in", async () => {
    process.env.FAKE_CURSOR_SIGNED_OUT = "1";
    const { ctx, engine } = await setup();
    try {
      expect(await engine.available({ fresh: true })).toMatchObject({ ok: false, need: "sign-in", reason: expect.stringContaining("cursor-agent login") });
    } finally {
      await ctx.fiber.dispose();
    }
    expect([cursorSignedIn("✓ Logged in as a@b.c"), cursorSignedIn("Not logged in"), cursorSignedIn("")]).toEqual([true, false, null]);
  });

  it("connects ~/.cursor/mcp.json, keeps the person's other servers, and takes it back out", async () => {
    const { ctx, dir, engine } = await setup();
    try {
      const file = cursorMcpFile();
      expect(file).toBe(path.join(dir, ".cursor", "mcp.json"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" } } }));
      const link = engine.mcpLink!;
      expect(await link.status()).toMatchObject({ state: "missing", file });
      expect(await link.connect()).toMatchObject({ state: "connected", configuredUrl: ctx.mcp.url });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" }, tomrade: { url: ctx.mcp.url } } });
      fs.writeFileSync(file, withMcpEntry(fs.readFileSync(file, "utf8"), "http://127.0.0.1:1/mcp"));
      expect(await link.status()).toMatchObject({ state: "stale", configuredUrl: "http://127.0.0.1:1/mcp" });
      expect(await link.disconnect()).toMatchObject({ state: "missing" });
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ mcpServers: { codegraph: { type: "stdio", command: "codegraph" } } });
      fs.writeFileSync(file, "{ not json");
      expect(await link.status()).toMatchObject({ state: "unavailable", error: expect.stringContaining(file) });
      expect(await link.connect()).toMatchObject({ state: "unavailable", error: expect.stringContaining("JSON") });
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("answers worker calls in ask mode from an empty folder, its whole input counted", async () => {
    const { ctx } = await setup();
    try {
      const lent = cursorLentModel(ctx, { cli: localCli("cursor-agent"), found: async () => true, options: () => ({ model: "gpt-5" }) });
      expect(lent).toMatchObject({ id: "cursor", title: "Cursor", rank: 80 });
      const answer = await collect(lent.model.chat({ system: "Be brief.", messages: [userMessage("hello")] }));
      const seen = JSON.parse(answer.text) as { args: string[]; prompt: string; cwd: string };
      expect(seen.args).toEqual(["-p", "--output-format", "json", "--mode", "ask", "--trust", "--model", "gpt-5"]);
      expect(seen.prompt.startsWith("Be brief.\n\n---\n\n")).toBe(true);
      expect(seen.prompt).toContain("hello");
      // One folder for every call, so cursor-agent keeps one background worker, not one per call.
      expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(cursorWorkerDir()));
      expect(answer.usage).toMatchObject({ inputTokens: 120 + 3840 + 2, outputTokens: 7, cacheReadTokens: 3840 });

      await expect(collect(lent.model.chat({ system: "", messages: [userMessage("SIGNED_OUT")] }))).rejects.toThrow("cursor-agent login");
      expect(await lent.ready()).toBe(false);
    } finally {
      await ctx.fiber.dispose();
    }
  });
});

describe("Cursor's hooks", () => {
  it("go into .cursor/hooks.json beside the person's own, once", () => {
    const mine = JSON.stringify({ version: 1, hooks: { stop: [{ command: "say done" }], afterFileEdit: [{ command: "prettier" }] } });
    const written = withCursorHooks(mine);
    const parsed = JSON.parse(written) as { version: number; hooks: Record<string, { command: string }[]> };
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.stop).toEqual([{ command: "say done" }, { command: CURSOR_HOOK_COMMAND }]);
    expect(parsed.hooks.afterFileEdit).toEqual([{ command: "prettier" }]);
    expect(Object.keys(parsed.hooks).sort()).toEqual(["afterAgentResponse", "afterFileEdit", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "preToolUse", "sessionEnd", "sessionStart", "stop"]);
    expect(hasCursorHooks(written)).toBe(true);
    expect(hasCursorHooks(mine)).toBe(false);
    expect(withCursorHooks(written)).toBe(written);
    expect(() => withCursorHooks("[1]")).toThrow("expected a JSON object");
    // Cursor skips a hook command that names curl, so the script carries it.
    expect(CURSOR_HOOK_COMMAND).not.toMatch(/curl|wget/);
    expect(cursorHookScript("curl x")).toMatch(/^#!\/bin\/sh\n[\s\S]*\ncurl x\n$/);
  });

  it("read in Claude Code's names, the last reply kept for the stop", () => {
    const read = cursorHookReader();
    // As cursor-agent 2026.10.16 sends them, trimmed.
    const base = { conversation_id: "c1", generation_id: "g1", session_id: "c1", workspace_roots: ["/repo"], cursor_version: "2026.10.16-e3cb207" };
    const at = { session_id: "c1", cwd: "/repo", tomrade_agent: "cursor" };
    expect(read({ ...base, hook_event_name: "beforeSubmitPrompt", prompt: "go" })).toEqual({ ...at, hook_event_name: "UserPromptSubmit" });
    expect(read({ ...base, hook_event_name: "sessionStart" })).toEqual({ ...at, hook_event_name: "SessionStart" });
    // the herdr pane the event endpoint added from the hook's header comes along
    expect(read({ ...base, hook_event_name: "sessionStart", herdr_pane: "w1:p1" })).toEqual({ ...at, herdr_pane: "w1:p1", hook_event_name: "SessionStart" });
    expect(read({ ...base, hook_event_name: "preToolUse", tool_name: "Shell", tool_input: { command: "ls" } })).toEqual({ ...at, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } });
    expect(read({ ...base, hook_event_name: "postToolUse", tool_name: "Read", tool_input: { file_path: "/repo/a" }, tool_output: "{}" })).toEqual({ ...at, hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "/repo/a" }, tool_output: "{}" });
    expect(read({ ...base, hook_event_name: "postToolUseFailure", tool_name: "Shell", tool_input: { command: "x" }, error_message: "exit 1" })).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_error: "exit 1" });
    expect(read({ ...base, hook_event_name: "afterAgentResponse", text: "Done." })).toBeNull();
    expect(read({ ...base, hook_event_name: "stop", status: "completed" })).toEqual({ ...at, hook_event_name: "Stop", last_assistant_message: "Done." });
    expect(read({ ...base, hook_event_name: "stop", status: "aborted" })).toEqual({ ...at, hook_event_name: "Stop" });
    expect(read({ ...base, hook_event_name: "stop", status: "error" })).toMatchObject({ hook_event_name: "StopFailure" });
    expect(read({ ...base, hook_event_name: "sessionEnd", reason: "completed" })).toEqual({ ...at, hook_event_name: "SessionEnd", reason: "completed" });
    expect(read({ ...base, hook_event_name: "beforeReadFile" })).toBeNull();
    expect(read({ hook_event_name: "stop" })).toBeNull();
  });
});
