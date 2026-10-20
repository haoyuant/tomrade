import { describe, expect, it } from "vitest";
import { CURSOR_HOOK_COMMAND, CURSOR_HOOK_POWERSHELL, CURSOR_HOOK_SCRIPT, LEGACY_CURSOR_HOOK_SCRIPT, cursorHookPowerShell, cursorHookReader, cursorHookScript, cursorHookScripts, withCursorHooks } from "../src/cursor-hooks.js";

describe("Cursor's hooks", () => {
  it("go into .cursor/hooks.json beside the person's own, once", () => {
    const mine = JSON.stringify({ version: 1, hooks: { stop: [{ command: "say done" }], afterFileEdit: [{ command: "prettier" }] } });
    const written = withCursorHooks(mine);
    const parsed = JSON.parse(written) as { version: number; hooks: Record<string, { command: string }[]> };
    expect(parsed.version).toBe(1);
    expect(parsed.hooks.stop).toEqual([{ command: "say done" }, { command: CURSOR_HOOK_COMMAND }]);
    expect(parsed.hooks.afterFileEdit).toEqual([{ command: "prettier" }]);
    expect(Object.keys(parsed.hooks).sort()).toEqual(["afterAgentResponse", "afterFileEdit", "beforeSubmitPrompt", "postToolUse", "postToolUseFailure", "preToolUse", "sessionEnd", "sessionStart", "stop"]);
    expect(cursorHookScripts(written)).toEqual([CURSOR_HOOK_SCRIPT, CURSOR_HOOK_POWERSHELL]);
    expect(cursorHookScripts(mine)).toEqual([]);
    expect(withCursorHooks(written)).toBe(written);
    expect(() => withCursorHooks("[1]")).toThrow("expected a JSON object");
    // Cursor skips a hook command that names curl, so the script carries it.
    expect(CURSOR_HOOK_COMMAND).not.toMatch(/curl|wget/);
    expect(cursorHookScript("curl x")).toMatch(/^#!\/bin\/sh\n[\s\S]*\ncurl x\n$/);
    expect(cursorHookPowerShell("exit 0")).toMatch(/^# [^\n]*\nexit 0\n$/);
    // A path without an extension: Cursor on Windows takes the .ps1 beside it.
    expect(CURSOR_HOOK_COMMAND).toBe(".cursor/hooks/tomrade");
    expect(CURSOR_HOOK_POWERSHELL).toBe(`${CURSOR_HOOK_COMMAND}.ps1`);
  });

  it("still count as connected when an older Tomrade ran its script through sh, and give way to today's", () => {
    const old = JSON.stringify({ version: 1, hooks: Object.fromEntries(["sessionStart", "beforeSubmitPrompt", "preToolUse", "postToolUse", "postToolUseFailure", "afterAgentResponse", "stop", "sessionEnd"].map((event) => [event, [{ command: "say done" }, { command: `sh ${LEGACY_CURSOR_HOOK_SCRIPT}` }]])) });
    expect(cursorHookScripts(old)).toEqual([LEGACY_CURSOR_HOOK_SCRIPT]);
    const now = JSON.parse(withCursorHooks(old)) as { hooks: Record<string, { command: string }[]> };
    expect(now.hooks.stop).toEqual([{ command: "say done" }, { command: CURSOR_HOOK_COMMAND }]);
    expect(cursorHookScripts(JSON.stringify(now))).toEqual([CURSOR_HOOK_SCRIPT, CURSOR_HOOK_POWERSHELL]);
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
