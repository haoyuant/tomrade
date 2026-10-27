/**
 * Gemini CLI (0.65) runs hooks from its settings, and a terminal session Tomrade
 * starts gets them in its own Gemini home: each event posted to the session's
 * address, read as Claude Code's, so its session id and record reach Tomrade.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, type CliHookCall } from "@tomradex/agent";
import { CodeLinkStore, MIGRATIONS, Sessions, TABLES, hookCommand } from "@tomradex/code-link";
import { Settings } from "@tomradex/settings";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { geminiHookPayload, geminiHooks } from "../src/gemini-hooks.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gemini-hooks-"));
const savedHome = process.env.GEMINI_CLI_HOME;
// The person's Gemini home a session's is made from: a stand-in, never this machine's own.
beforeAll(() => {
  fs.mkdirSync(path.join(tmp, "own", ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "own", ".gemini", "settings.json"), JSON.stringify({ security: { auth: { selectedType: "gemini-api-key" } } }));
  process.env.GEMINI_CLI_HOME = path.join(tmp, "own");
});
afterAll(() => {
  if (savedHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

// What Gemini CLI 0.65 posted in a real run (`createBaseInput` and each event's fields), its paths shortened.
const base = { session_id: "d719c392-f2b1-4f50-a3f6-8da79b80ccb1", transcript_path: "/h/.gemini/tmp/work/chats/session-2026-10-27T12-32-d719c392.jsonl", cwd: "/w/work", timestamp: "2026-10-27T12:32:42.177Z" };
const said = {
  start: { ...base, hook_event_name: "SessionStart", source: "startup" },
  prompt: { ...base, hook_event_name: "BeforeAgent", prompt: "Run the shell command: echo hi" },
  compress: { ...base, hook_event_name: "PreCompress", trigger: "auto" },
  before: { ...base, hook_event_name: "BeforeTool", tool_name: "run_shell_command", tool_input: { command: "echo hi", description: "Say hi" } },
  asks: { ...base, hook_event_name: "Notification", notification_type: "ToolPermission", message: "Tool Shell requires execution", details: { type: "exec" } },
  after: { ...base, hook_event_name: "AfterTool", tool_name: "run_shell_command", tool_input: { command: "echo hi", description: "Say hi" }, tool_response: { llmContent: "<untrusted_context>\nOutput: hi\nProcess Group PGID: 73050\n</untrusted_context>", returnDisplay: "hi" } },
  failed: { ...base, hook_event_name: "AfterTool", tool_name: "read_file", tool_input: { file_path: "/w/work/missing.txt" }, tool_response: { llmContent: "File not found", returnDisplay: "File not found", error: { message: "File not found: /w/work/missing.txt", type: "file_not_found" } } },
  stop: { ...base, hook_event_name: "AfterAgent", prompt: "Run the shell command: echo hi", prompt_response: "Done.", stop_hook_active: false },
  end: { ...base, hook_event_name: "SessionEnd", reason: "exit" }
};

describe("Gemini CLI's hooks", () => {
  it("are added after the person's own on each event Tomrade reads, and print nothing back", () => {
    const url = "http://127.0.0.1:19090/sessions/tok/event";
    const ours = { hooks: [{ type: "command", name: "tomrade", command: hookCommand(url), timeout: 5000 }] };
    const mine = { matcher: "write_file", hooks: [{ type: "command", command: "./fmt.sh" }] };
    const hooks = geminiHooks(url, { AfterTool: [mine], PreCompress: [mine], disabled: ["x"] });
    expect(Object.keys(hooks).sort()).toEqual(["AfterAgent", "AfterTool", "BeforeAgent", "BeforeTool", "Notification", "PreCompress", "SessionEnd", "SessionStart", "disabled"]);
    expect(hooks.AfterTool).toEqual([mine, ours]);
    expect(hooks.BeforeTool).toEqual([ours]);
    expect(hooks.PreCompress).toEqual([mine]);
    expect(hooks.disabled).toEqual(["x"]);
    // The answer is swallowed: Gemini would read anything on stdout as its own, and a hook that waits slows it.
    expect(ours.hooks[0]!.command).toContain("curl -s -m 2 ");
    expect(ours.hooks[0]!.command).toMatch(/set tomrade "\$\(curl .* 2>&1\)"; exit 0$/);
    expect(geminiHooks(url, "not hooks")).toEqual(geminiHooks(url));
  });

  it("are read as Claude Code's, with its session id, record and folder as they are", () => {
    const kept = { session_id: base.session_id, transcript_path: base.transcript_path, cwd: base.cwd };
    expect(geminiHookPayload(said.start)).toMatchObject({ ...kept, hook_event_name: "SessionStart", source: "startup" });
    expect(geminiHookPayload(said.prompt)).toMatchObject({ ...kept, hook_event_name: "UserPromptSubmit", prompt: "Run the shell command: echo hi" });
    expect(geminiHookPayload(said.before)).toMatchObject({ ...kept, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo hi", description: "Say hi" } });
    expect(geminiHookPayload(said.asks)).toMatchObject({ ...kept, hook_event_name: "Notification", notification_type: "permission_prompt" });
    expect(geminiHookPayload(said.after)).toMatchObject({ ...kept, hook_event_name: "PostToolUse", tool_name: "Bash", tool_output: said.after.tool_response.llmContent });
    expect(geminiHookPayload(said.failed)).toMatchObject({ hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_input: { file_path: "/w/work/missing.txt" }, tool_error: "File not found: /w/work/missing.txt" });
    expect(geminiHookPayload(said.stop)).toMatchObject({ ...kept, hook_event_name: "Stop", last_assistant_message: "Done." });
    expect(geminiHookPayload(said.end)).toMatchObject({ ...kept, hook_event_name: "SessionEnd", reason: "exit" });
    // A tool Claude Code has no name for keeps Gemini's; MCP tools keep theirs, which the claim check reads.
    expect(geminiHookPayload({ ...said.before, tool_name: "mcp_tomrade_claim_ticket", tool_input: { key: "TOM-1" } })).toMatchObject({ tool_name: "mcp_tomrade_claim_ticket", tool_input: { key: "TOM-1" } });
    // What Tomrade does not read.
    expect(geminiHookPayload(said.compress)).toBeNull();
    expect(geminiHookPayload({ ...said.asks, notification_type: "Other" })).toBeNull();
    expect(geminiHookPayload(null)).toBeNull();
  });
});

/** Enough of the MCP server for a session to bind its token, keeping what the token does when used. */
const bindings = new Map<string, { event?: (payload: unknown) => unknown }>();
const fakeMcp = {
  name: "fake-mcp",
  apply(ctx: Context) {
    ctx.provide("mcp", {
      url: "http://127.0.0.1:1/mcp",
      instruct: () => () => {},
      bindRun: (token: string, binding: { event?: (payload: unknown) => unknown }) => {
        bindings.set(token, binding);
        return () => bindings.delete(token);
      },
      urlFor: () => "http://127.0.0.1:1/mcp",
      eventUrlFor: (token: string) => `http://127.0.0.1:1/sessions/${token}/event`
    } as never);
  }
};

async function world(heard: CliHookCall[]) {
  const listener = { name: "listener", apply: (ctx: Context) => void ctx.on("agent/cli-hook", (call) => void heard.push(call)) };
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(tmp, `settings-${Math.random()}.json`) }], [Agent, { mediaDir: path.join(tmp, "media") }], fakeMcp, listener] });
  w.ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
  const store = new CodeLinkStore(w.ctx.db);
  const sessions = new Sessions(w.ctx, store, { dirOf: (id) => path.join(tmp, id), onChange: () => {}, prefixOf: () => "TOM" });
  const ticket = w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Ship it", by: "human" });
  const start = (agent: string) => {
    const s = store.createSession(w.project.id, { repoId: "repo", branch: "tom-1/ship", itemIds: [ticket.id], mode: "terminal", agent, threadId: null, device: "here" });
    const files = sessions.bind(s, "ai:agent", path.join(tmp, s.id), "go")!;
    // As the hook posts it: through the session's token.
    const post = (payload: unknown) => bindings.get(files.token)!.event!(payload) as Promise<Record<string, unknown>>;
    return { id: s.id, files, post, now: () => store.session(w.project.id, s.id)! };
  };
  return { ...w, store, sessions, start };
}

describe("a Gemini CLI session Tomrade started", () => {
  it("reports its id, its record and its turns through the hooks in its home, and ends with them", async () => {
    const heard: CliHookCall[] = [];
    const { ctx, start } = await world(heard);
    const gemini = start("gemini");
    const settings = JSON.parse(fs.readFileSync(path.join(gemini.files.geminiHome, ".gemini", "settings.json"), "utf8"));
    expect(settings.hooks).toEqual(geminiHooks(gemini.files.eventUrl));
    expect(gemini.now().externalId).toBeNull();

    expect(await gemini.post(said.start)).toEqual({});
    expect(gemini.now()).toMatchObject({ externalId: base.session_id, transcript: base.transcript_path, cwd: base.cwd, state: "running" });
    await gemini.post(said.prompt);
    expect(gemini.now().prompted).toBe(true);
    await gemini.post(said.before);
    expect(gemini.now()).toMatchObject({ state: "running", activity: "Bash · echo hi" });
    await gemini.post(said.asks);
    expect(gemini.now()).toMatchObject({ state: "waiting", activity: "needs your approval" });
    await gemini.post(said.after);
    expect(gemini.now()).toMatchObject({ state: "running", activity: null });
    // An event Tomrade does not read is not even a sign of life.
    const before = gemini.now().lastEventAt;
    expect(await gemini.post(said.compress)).toEqual({});
    expect(gemini.now().lastEventAt).toBe(before);
    await gemini.post(said.stop);
    expect(gemini.now()).toMatchObject({ state: "waiting", summary: "Done." });
    await gemini.post(said.end);
    expect(gemini.now()).toMatchObject({ state: "ended", externalId: base.session_id, transcript: base.transcript_path });

    // Plugins hear Gemini's events in the one set of names, and their answers go nowhere.
    expect(heard.map((call) => call.event)).toEqual(["session-start", "prompt", "pre-tool", "post-tool", "stop", "session-end"]);
    expect(heard.every((call) => call.agent === "gemini" && !call.answerable)).toBe(true);
    expect(heard[2]).toMatchObject({ tool: { name: "Bash", input: { command: "echo hi" } }, cwd: base.cwd });
    expect(heard[4]).toMatchObject({ text: "Done." });
    await ctx.fiber.dispose();
  });

  it("is the only agent whose posts are read that way", async () => {
    const { ctx, start } = await world([]);
    const claude = start("claude-code");
    // Claude Code has no BeforeTool: nothing in it is read as a tool call.
    await claude.post({ ...said.before, session_id: "c1" });
    expect(claude.now()).toMatchObject({ externalId: "c1", activity: null });
    await ctx.fiber.dispose();
  });
});
