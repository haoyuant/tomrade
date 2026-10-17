import { describe, expect, it } from "vitest";
import { TerminalSettings, fillTemplate, optionFlags, withOptions } from "@tomradex/code-link";

describe("terminal command options", () => {
  it("turns the model and effort picked at Start into each CLI's own flags", () => {
    expect(optionFlags("claude-code", { model: "opus", effort: "high" })).toBe("--model opus --effort high");
    expect(optionFlags("codex", { model: "gpt-5", effort: "medium" })).toBe("-m gpt-5 -c model_reasoning_effort=medium");
    expect(optionFlags("pi", { model: "anthropic/claude-sonnet-4-5", effort: "high" })).toBe("--model anthropic/claude-sonnet-4-5 --thinking high");
    expect(optionFlags("workbuddy", { model: "hy3", effort: "max" })).toBe("--model hy3 --effort max");
    expect(optionFlags("hermes", { model: "openrouter:x" })).toBe("-m openrouter:x");
    expect(optionFlags("dsh", { model: "deepseek-v4-pro" })).toBe("");
    expect(TerminalSettings.parse({}).dshCommand).toBe('"{bin}" --profile headless --patch "{dshPatch}" --json {resume} - < "{prompt}" | ELECTRON_RUN_AS_NODE=1 "{node}" "{dshReporter}"');
    expect(optionFlags("claude-code", { effort: "high" })).toBe("--effort high");
    expect(optionFlags("claude-code", { model: "  " })).toBe("");
    expect(optionFlags("other", { model: "x" })).toBe("");
    expect(optionFlags("claude-code", undefined)).toBe("");
    // a value typed by hand is quoted for the shell rather than trusted
    expect(optionFlags("claude-code", { model: "my model; rm -rf" })).toBe("--model 'my model; rm -rf'");
  });

  it("fills the {options} slot, or puts the flags right after the command for a template saved before the slot existed", () => {
    const defaults = TerminalSettings.parse({});
    expect(defaults.claudeCommand).toContain("{options}");
    expect(defaults.codexCommand).toContain("{options}");
    const values = { cwd: "/w", prompt: "/s/prompt.md", mcpConfig: "/s/mcp.json", mcpUrl: "http://127.0.0.1:1/mcp", token: "t", settings: "/s/settings.json", resume: "" };
    expect(fillTemplate(withOptions(defaults.claudeCommand, ""), values)).toBe('claude --mcp-config "/s/mcp.json" --settings "/s/settings.json" "$(cat "/s/prompt.md")"');
    expect(fillTemplate(withOptions(defaults.claudeCommand, "--model opus"), values)).toBe('claude --model opus --mcp-config "/s/mcp.json" --settings "/s/settings.json" "$(cat "/s/prompt.md")"');
    expect(fillTemplate(withOptions(defaults.codexCommand, "-m gpt-5"), { ...values, resume: "resume abc" })).toMatch(/^codex resume abc -m gpt-5 -c mcp_servers/);
    expect(fillTemplate(withOptions(defaults.piCommand, "--thinking high"), { ...values, piExtension: "/s/pi-extension.ts", resume: "--session-id abc" }))
      .toBe('pi --thinking high -e "/s/pi-extension.ts" --session-id abc "$(cat "/s/prompt.md")"');
    expect(fillTemplate(withOptions(defaults.workbuddyCommand, "--model hy3"), { ...values, resume: "--resume abc" }))
      .toBe('codebuddy --model hy3 --mcp-config "/s/mcp.json" --settings "/s/settings.json" --resume abc "$(cat "/s/prompt.md")"');
    const legacy = 'claude --mcp-config "{mcpConfig}" "$(cat "{prompt}")"';
    expect(withOptions(legacy, "--effort high")).toBe('claude --effort high --mcp-config "{mcpConfig}" "$(cat "{prompt}")"');
    expect(withOptions(legacy, "")).toBe(legacy);
  });
});
