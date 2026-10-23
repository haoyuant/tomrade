import { describe, expect, it } from "vitest";
import { settle } from "@tomradex/testkit";
import { opencodePlugin } from "../src/opencode-files.js";

describe("the reporting plugin", () => {
  /** Runs the plugin module against a stand-in for OpenCode's plugin host, as 1.19.3 calls it. */
  async function load(env: Record<string, string> = {}) {
    const source = opencodePlugin("http://127.0.0.1:19090/sessions/event");
    const posted: { url: string; agent: string | null; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    const before = { ...process.env };
    Object.assign(process.env, env);
    globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      posted.push({ url, agent: init.headers["x-tomrade-agent"] ?? null, body: JSON.parse(init.body) });
      return new Response("{}");
    }) as typeof fetch;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("tomrade.opencode")];
    // vitest imports nothing outside the repository: the module's one export, run as a function.
    const plugin = new Function(source.replace("export const TomradePlugin =", "return"))() as (ctx: { directory: string }) => Promise<Record<string, (...args: unknown[]) => Promise<void>>>;
    const hooks = await plugin({ directory: "/work/app" });
    return { hooks, posted, again: () => plugin({ directory: "/work/app" }), restore: () => { globalThis.fetch = realFetch; process.env = before; } };
  }

  it("reports a session as OpenCode with its folder, in Claude Code's event names", async () => {
    const { hooks, posted, again, restore } = await load();
    try {
      await hooks.event!({ event: { type: "session.created", properties: { sessionID: "ses_1", info: { id: "ses_1", title: "OpenCode 标题" } } } });
      await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user", parts: [{ type: "text", text: "改一下侧栏" }] } } } });
      await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_1", info: { id: "msg_1", role: "user" } } } });
      await hooks.event!({ event: { type: "session.updated", properties: { sessionID: "ses_1", info: { id: "ses_1", title: "改好的标题" } } } });
      await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_1", callID: "c1" }, { args: { command: "ls" } });
      await hooks["tool.execute.after"]!({ tool: "bash", sessionID: "ses_1", callID: "c1", args: { command: "ls" } }, { title: "ls", output: "a\n" });
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
      await hooks.event!({ event: { type: "session.error", properties: { sessionID: "ses_1", error: { name: "APIError", data: { message: "rate limited" } } } } });
      await settle();
      expect(posted.map((p) => [p.url, p.agent, p.body.hook_event_name, p.body.session_id, p.body.cwd])).toEqual([
        ["http://127.0.0.1:19090/sessions/event", "opencode", "SessionStart", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "UserPromptSubmit", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "TitleUpdate", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "PreToolUse", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "PostToolUse", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "Stop", "ses_1", "/work/app"],
        ["http://127.0.0.1:19090/sessions/event", "opencode", "StopFailure", "ses_1", "/work/app"]
      ]);
      // What it calls the conversation, and what was asked, so the sidebar has a title either way.
      expect(posted[0]!.body).toMatchObject({ title: "OpenCode 标题" });
      expect(posted[1]!.body).toMatchObject({ prompt: "改一下侧栏" });
      expect(posted[2]!.body).toMatchObject({ title: "改好的标题" });
      expect(posted[3]!.body).toMatchObject({ tool_name: "Bash", tool_input: { command: "ls" } });
      expect(posted[6]!.body).toMatchObject({ error_message: "rate limited" });
      // A second copy (the repository's, beside the global one) does nothing.
      expect(await again()).toEqual({});
    } finally {
      restore();
    }
  });

  it("reports to the session's own address when Tomrade started it", async () => {
    const { hooks, posted, restore } = await load({ TOMRADE_MCP_TOKEN: "tok-9" });
    try {
      await hooks.event!({ event: { type: "session.idle", properties: { sessionID: "ses_2" } } });
      await settle();
      expect(posted.map((p) => p.url)).toEqual(["http://127.0.0.1:19090/sessions/tok-9/event"]);
    } finally {
      restore();
    }
  });
});
