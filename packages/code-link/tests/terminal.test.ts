import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TerminalSettings, fillTemplate, herdrFallbackNote, launchTerminal, optionFlags, setupTerminal, terminalApp, terminalApps, terminalTemplate, withOptions, writeGeminiHome, type HerdrTerminal } from "@tomradex/code-link";

it("lists installed terminal apps with the special launch choices", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-terminal-apps-"));
  try {
    for (const name of ["Warp.app", "Utilities/Terminal.app", "Notes.app"]) fs.mkdirSync(path.join(root, name), { recursive: true });
    expect(terminalApps([root], "darwin")).toEqual(["Terminal", "Warp", "herdr", "none"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("a terminal of herdr", () => {
  it("defaults to herdr and preserves a saved terminal choice", () => {
    expect(TerminalSettings.parse({}).terminal).toBe("herdr");
    expect(TerminalSettings.parse({ terminal: "Terminal" }).terminal).toBe("Terminal");
    expect(TerminalSettings.parse({ terminal: "none" }).terminal).toBe("none");
  });

  it("runs the script in a herdr workspace labelled for the ticket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-terminal-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const launches: { cwd: string; label?: string; command: string }[] = [];
    const herdr: HerdrTerminal = { launch: async (input) => { launches.push(input); return { paneId: "w2:p1" }; }, installed: async () => "0.9.5" };
    const launched = await launchTerminal({ cwd: "/work/tom-9", command: "claude", env: { TOMRADE_MCP_TOKEN: "t" }, dir, label: "TOM-9" }, "herdr", herdr);
    expect(launched).toEqual({ script: path.join(dir, "run.command"), launched: true, paneId: "w2:p1" });
    expect(launches).toEqual([{ cwd: "/work/tom-9", label: "TOM-9", command: `bash '${path.join(dir, "run.command")}'` }]);
    expect(fs.readFileSync(path.join(dir, "run.command"), "utf8")).toContain("export TOMRADE_MCP_TOKEN='t'\nclaude");
    // any other terminal is untouched by herdr being there
    expect(await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "none", herdr)).toEqual({ script: path.join(dir, "run.command"), launched: false });
    expect(launches.length).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("without herdr opens the script in the system terminal, and says why", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-fallback-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const script = path.join(dir, "run.command");
    const stopped: HerdrTerminal = { launch: async () => null, installed: async () => "0.9.5" };
    const absent: HerdrTerminal = { launch: async () => null, installed: async () => null };

    const notRunning = await launchTerminal({ cwd: "/work/tom-9", command: "claude", env: { TOMRADE_MCP_TOKEN: "t" }, dir, label: "TOM-9", resume: "claude --resume x" }, "herdr", stopped);
    expect(notRunning).toEqual({ script, launched: true, herdrMissing: "notRunning" });
    expect(opened).toHaveBeenLastCalledWith("Terminal", script);
    // the same script any terminal app gets: the heartbeat, the token and the resume beside it
    const written = fs.readFileSync(script, "utf8");
    expect(written).toContain("echo $$ >");
    expect(written).toContain("export TOMRADE_MCP_TOKEN='t'\nclaude");
    expect(fs.readFileSync(path.join(dir, "resume.command"), "utf8")).toContain("claude --resume x");
    expect(await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "herdr", absent)).toEqual({ script, launched: true, herdrMissing: "notInstalled" });
    expect(await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "herdr", null)).toEqual({ script, launched: true, herdrMissing: "notInstalled" });
    // engine setup goes the same way
    expect(await setupTerminal("npm i -g x", dir, "herdr", absent)).toEqual({ launched: true });
    expect(opened).toHaveBeenCalledTimes(4);

    // the system terminal failing too leaves the script for the person
    opened.mockRejectedValueOnce(new Error("no app"));
    const failed = await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "herdr", stopped);
    expect(failed).toEqual({ script, launched: false, herdrMissing: "notRunning" });

    const app = process.platform === "darwin" ? "Terminal" : "the system terminal";
    expect(herdrFallbackNote("en", notRunning, "brew install herdr")).toBe(`herdr is not running, so this opened in ${app} instead. Start herdr by running \`herdr\` in a terminal.`);
    expect(herdrFallbackNote("en", { script, launched: true, herdrMissing: "notInstalled" }, "brew install herdr")).toContain("brew install herdr");
    expect(herdrFallbackNote("en", failed, "brew install herdr")).toContain("run the command yourself");
    expect(herdrFallbackNote("zh", notRunning, "brew install herdr")).toContain("herdr 没有在运行");
    expect(herdrFallbackNote("en", { script, launched: true, paneId: "w1:p1" }, "brew install herdr")).toBeNull();
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("terminal command options", () => {
  it("turns the model and effort picked at Start into each CLI's own flags", () => {
    expect(optionFlags("claude-code", { model: "opus", effort: "high" })).toBe("--model opus --effort high");
    expect(optionFlags("codex", { model: "gpt-5", effort: "medium" })).toBe("-m gpt-5 -c model_reasoning_effort=medium");
    expect(optionFlags("pi", { model: "anthropic/claude-sonnet-4-5", effort: "high" })).toBe("--model anthropic/claude-sonnet-4-5 --thinking high");
    expect(optionFlags("workbuddy", { model: "hy3", effort: "max" })).toBe("--model hy3 --effort max");
    expect(optionFlags("hermes", { model: "openrouter:x" })).toBe("-m openrouter:x");
    expect(optionFlags("dsh", { model: "deepseek-v4-pro" })).toBe("");
    expect(optionFlags("agy", { model: "gemini-3.6-flash", effort: "high" })).toBe("--model gemini-3.6-flash --effort high");
    expect(optionFlags("cursor", { model: "gpt-5", effort: "high" })).toBe("--model gpt-5");
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

describe("Gemini CLI's session home", () => {
  it("is the person's own ~/.gemini, linked, with the server added to a copy of its settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gemini-home-"));
    const own = path.join(root, "me", ".gemini");
    fs.mkdirSync(path.join(own, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(own, "oauth_creds.json"), "{}");
    // Gemini reads its settings as JSON with comments.
    fs.writeFileSync(path.join(own, "settings.json"), '{\n  // the person\'s own\n  "theme": "Dracula", /* a "quoted" note */\n  "url": "http://x//y",\n  "mcpServers": { "mine": { "command": "mine" } }\n}\n');
    fs.writeFileSync(path.join(root, "me", ".env"), "GEMINI_API_KEY=k\n");
    const home = path.join(root, "session", "gemini-home");
    const tomrade = { httpUrl: "http://127.0.0.1:1/mcp/p", headers: { "X-Tomrade-Run": "t" } };
    writeGeminiHome(home, { tomrade }, own);

    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"))).toEqual({ theme: "Dracula", url: "http://x//y", mcpServers: { mine: { command: "mine" }, tomrade } });
    expect(fs.realpathSync(path.join(home, ".gemini", "oauth_creds.json"))).toBe(fs.realpathSync(path.join(own, "oauth_creds.json")));
    expect(fs.realpathSync(path.join(home, ".gemini", "extensions"))).toBe(fs.realpathSync(path.join(own, "extensions")));
    expect(fs.realpathSync(path.join(home, ".env"))).toBe(fs.realpathSync(path.join(root, "me", ".env")));
    // The person's own settings are read, never written.
    expect(fs.readFileSync(path.join(own, "settings.json"), "utf8")).toContain("// the person's own");

    // Bound again (a resumed session): laid down afresh, the same way.
    writeGeminiHome(home, { tomrade: { ...tomrade, headers: { "X-Tomrade-Run": "t2" } } }, own);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8")).mcpServers.tomrade.headers).toEqual({ "X-Tomrade-Run": "t2" });

    // No ~/.gemini yet, or settings Gemini could not read either: the server alone.
    writeGeminiHome(home, { tomrade }, path.join(root, "nobody", ".gemini"));
    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"))).toEqual({ mcpServers: { tomrade } });
  });

  it("moves a command saved before Gemini 0.64 onto the session home", () => {
    expect(terminalTemplate(TerminalSettings.parse({}), "gemini")).toBe('GEMINI_CLI_HOME="{geminiHome}" gemini {options} {resume} -i "$(cat "{prompt}")"');
    const saved = TerminalSettings.parse({ geminiCommand: 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH="{geminiSettings}" gemini --yolo {options} {resume} -i "$(cat "{prompt}")"' });
    expect(terminalTemplate(saved, "gemini")).toBe('GEMINI_CLI_HOME="{geminiHome}" gemini --yolo {options} {resume} -i "$(cat "{prompt}")"');
  });
});
