/**
 * Plugins hook into the CLI agents Tomrade works with: every agent's hooks are
 * heard in one set of names, and in a session Tomrade started an agent that
 * acts on the answer gets it — in Claude Code's shape, which Claude Code, Pi's
 * session extension and DeepSeek Harness's own bridge read. A connected
 * repository's hooks are only heard.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterAll, describe, expect, it } from "vitest";
import { Agent, type CliHookCall } from "@tomradex/agent";
import { CodeLinkStore, MIGRATIONS, Sessions, TABLES, cliHookEvent, dshHooksSettings, hookReply, mergeAnswers } from "@tomradex/code-link";
import { definePlugin } from "@tomradex/plugin-sdk";
import { Settings } from "@tomradex/settings";
import { fresh, sdk, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cli-hooks-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Enough of the MCP server for a session to bind a token and lay down its files. */
const fakeMcp = {
  name: "fake-mcp",
  apply(ctx: Context) {
    ctx.provide("mcp", { url: "http://127.0.0.1:1/mcp", instruct: () => () => {}, bindRun: () => () => {}, urlFor: () => "http://127.0.0.1:1/mcp", eventUrlFor: (token: string) => `http://127.0.0.1:1/sessions/${token}/event` } as never);
  }
};

async function world(plugins: unknown[] = []) {
  const w = await fresh({ plugins: [Tools, [Settings, { path: path.join(tmp, `settings-${Math.random()}.json`) }], [Agent, { mediaDir: path.join(tmp, "media") }], fakeMcp, ...(plugins as never[])] });
  w.ctx.db.migrate("code_link", MIGRATIONS, { tables: TABLES });
  const store = new CodeLinkStore(w.ctx.db);
  const sessions = new Sessions(w.ctx, store, { dirOf: (id) => path.join(tmp, id), onChange: () => {} });
  const ticket = w.items.create({ projectId: w.project.id, boardId: w.board.id, title: "Ship it", by: "human" });
  const session = (agent: string, bound: boolean) => {
    const s = store.createSession(w.project.id, { repoId: "repo", branch: "tom-1/ship", itemIds: [ticket.id], mode: "terminal", agent, threadId: null, device: "here" });
    const files = bound ? sessions.bind(s, "ai:agent", path.join(tmp, s.id), "go") : null;
    return { id: s.id, files };
  };
  const heard: CliHookCall[] = [];
  return { ...w, store, sessions, ticket, session, heard };
}

/** A built-in plugin's hook: it hears everything and refuses `rm`, keeps a turn going once, and adds context after tools. */
const listener = (heard: CliHookCall[]) => ({
  name: "listener",
  apply(ctx: Context) {
    ctx.on("agent/cli-hook", (call) => {
      heard.push(call);
      if (call.event === "pre-tool" && JSON.stringify(call.tool?.input).includes("rm -rf")) return { deny: "not here" };
      if (call.event === "stop") return { continue: "run the tests first" };
      if (call.event === "post-tool") return { context: "the build is green" };
      return undefined;
    });
  }
});

describe("CLI agents' hooks", () => {
  it("are read in one set of names, and answered in the shape every agent that answers reads", () => {
    expect(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop", "SessionEnd", "Notification"].map(cliHookEvent)).toEqual(["session-start", "prompt", "pre-tool", "post-tool", "post-tool", "stop", "session-end", null]);
    expect(hookReply("PreToolUse", { deny: "no" })).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } });
    expect(hookReply("Stop", { continue: "go on" })).toEqual({ decision: "block", reason: "go on" });
    expect(hookReply("PostToolUseFailure", { context: "c" })).toEqual({ additionalContext: "c", hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: "c" } });
    // An answer an event cannot carry is dropped, not misread.
    expect(hookReply("SessionEnd", { deny: "no", context: "c" })).toEqual({});
    // Tomrade's own refusal is never a plugin's to lift; context sits beside its own.
    expect(mergeAnswers({ deny: "credentials" }, { context: "x" })).toEqual({ deny: "credentials" });
    expect(mergeAnswers({ context: "mine" }, { context: "theirs", deny: "no" })).toEqual({ deny: "no", context: "mine\n\ntheirs" });
  });

  it("in a session Tomrade started, reach plugins and carry back an answer the agent acts on", async () => {
    const heard: CliHookCall[] = [];
    const { sessions, project, ticket, session, ctx } = await world([listener(heard)]);
    const claude = session("claude-code", true);
    const denied = await sessions.hook(project.id, claude.id, { hook_event_name: "PreToolUse", session_id: "c1", cwd: "/w", tool_name: "Bash", tool_input: { command: "rm -rf /" } }, true);
    expect(denied).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "not here" } });
    expect(heard[0]).toMatchObject({ event: "pre-tool", agent: "claude-code", answerable: true, projectId: project.id, sessionId: claude.id, ticket: ticket.key, cwd: "/w", tool: { name: "Bash", input: { command: "rm -rf /" } } });
    expect(await sessions.hook(project.id, claude.id, { hook_event_name: "Stop", last_assistant_message: "done" }, true)).toEqual({ decision: "block", reason: "run the tests first" });
    expect(heard.at(-1)).toMatchObject({ event: "stop", text: "done" });

    // Pi's session extension acts on a refusal and on context after a tool, not on a stop.
    const pi = session("pi", true);
    expect(await sessions.hook(project.id, pi.id, { hook_event_name: "Stop", last_assistant_message: "done" }, true)).toEqual({});
    expect(heard.at(-1)).toMatchObject({ agent: "pi", answerable: false });
    expect(await sessions.hook(project.id, pi.id, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {}, tool_output: "ok" }, true)).toMatchObject({ additionalContext: "the build is green" });
    await ctx.fiber.dispose();
  });

  it("from a connected repository are only heard, and not twice for a session that reports through its token", async () => {
    const heard: CliHookCall[] = [];
    const { sessions, project, session, ctx } = await world([listener(heard)]);
    const codex = session("codex", false);
    expect(await sessions.hook(project.id, codex.id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" } }, false)).toEqual({});
    expect(heard).toEqual([expect.objectContaining({ agent: "codex", answerable: false })]);

    const claude = session("claude-code", true);
    await sessions.hook(project.id, claude.id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }, false);
    expect(heard).toHaveLength(1);
    await ctx.fiber.dispose();
  });

  it("in dsh are answered through dsh's own Claude Code bridge, while its reporter still tells the session's story", async () => {
    const heard: CliHookCall[] = [];
    const { sessions, store, project, session, ctx } = await world([listener(heard)]);
    const dsh = session("dsh", true);
    const patch = fs.readFileSync(dsh.files!.dshPatch, "utf8");
    const hooksFile = path.join(path.dirname(dsh.files!.dshPatch), "dsh-hooks.json");
    expect(patch).toContain("name: '@deepseek-ai/dsh-hooks-claude-code'");
    expect(patch).toContain(`configPath: ${JSON.stringify(hooksFile)}`);
    const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(hooks).toEqual(dshHooksSettings(dsh.files!.eventUrl));
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]);
    expect(hooks.hooks.PreToolUse![0]!.hooks[0]!.command).toContain('-H "X-Tomrade-Source: dsh-hooks"');

    // The bridge's post: answered, and the session's story left to the reporter.
    const answer = await sessions.hook(project.id, dsh.id, { hook_event_name: "PreToolUse", tool_name: "bash", tool_input: { command: "rm -rf /" }, tomrade_source: "dsh-hooks" }, true);
    expect(answer).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(store.session(project.id, dsh.id)!.activity ?? null).toBeNull();
    // The reporter's post of the same: recorded, not heard twice.
    await sessions.hook(project.id, dsh.id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm -rf /" }, tomrade_source: "dsh-report" }, true);
    expect(store.session(project.id, dsh.id)!.activity).toBeTruthy();
    expect(heard.filter((c) => c.event === "pre-tool")).toHaveLength(1);
    // What the bridge does not carry comes from the reporter.
    await sessions.hook(project.id, dsh.id, { hook_event_name: "SessionEnd", reason: "exit", tomrade_source: "dsh-report" }, true);
    expect(heard.at(-1)).toMatchObject({ event: "session-end", agent: "dsh", answerable: false });
    await ctx.fiber.dispose();
  });

  it("from an SDK plugin hear only what it asked for, and answer only where the agent acts on it", async () => {
    const seen: string[] = [];
    const plugin = definePlugin({
      inject: ["agent"],
      async apply(p) {
        await p.agent.cliHook({
          events: ["pre-tool", "stop"],
          tools: "^Bash$",
          agents: ["claude-code", "pi"],
          handle: (call) => {
            seen.push(`${call.agent} ${call.event} ${call.tool?.name ?? ""}`.trim());
            return call.event === "pre-tool" ? { deny: "the plugin says no" } : { continue: "one more thing" };
          }
        });
      }
    });
    const { sessions, project, session, ctx } = await world([sdk(plugin as never, { id: "someone/guard", namespace: "guard", origin: "extension" })]);
    await settle();
    const claude = session("claude-code", true);
    expect(await sessions.hook(project.id, claude.id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, true)).toMatchObject({ hookSpecificOutput: { permissionDecisionReason: "the plugin says no" } });
    expect(await sessions.hook(project.id, claude.id, { hook_event_name: "PreToolUse", tool_name: "Read", tool_input: {} }, true)).toEqual({});
    expect(await sessions.hook(project.id, claude.id, { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: {} }, true)).toEqual({});
    // A stop names no tool, so a tool pattern leaves it out.
    expect(await sessions.hook(project.id, claude.id, { hook_event_name: "Stop" }, true)).toEqual({});
    const codex = session("codex", true);
    expect(await sessions.hook(project.id, codex.id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, true)).toEqual({});
    const pi = session("pi", true);
    expect(await sessions.hook(project.id, pi.id, { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, true)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(seen).toEqual(["claude-code pre-tool Bash", "pi pre-tool Bash"]);
    await ctx.fiber.dispose();
  });
});
