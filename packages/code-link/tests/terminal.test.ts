import { describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTO_TERMINAL, BUILTIN_TERMINAL, GitBashMissing, fitsCommandLine, promptAsArgument, SYSTEM_TERMINAL, TerminalSettings, bareCommand, fillTemplate, gitBash, herdrFallbackNote, launchTerminal, locatedCommand, machineTerminalSettings, openOnLinux, openOnWindows, optionFlags, pathExport, powerShellPath, setupOnWindows, setupTerminal, terminalApp, terminalApps, terminalPath, terminalTemplate, withOptions, writeGeminiHome, hookCommand, type PaneTerminal } from "@tomradex/code-link";
import { geminiHooks } from "../src/gemini-hooks.js";

it("lists installed terminal apps with the special launch choices", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-terminal-apps-"));
  try {
    for (const name of ["Warp.app", "Utilities/Terminal.app", "Notes.app"]) fs.mkdirSync(path.join(root, name), { recursive: true });
    expect(terminalApps([root], "darwin")).toEqual(["Terminal", "Warp", "none"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("offers Tomrade's own terminal on Windows, where herdr does not run", () => {
  expect(terminalApps([], "win32")).toEqual(["none"]);
});

it.skipIf(process.platform === "win32")("lists the Linux emulators on PATH, $TERMINAL first", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-linux-terminals-"));
  try {
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    for (const name of ["kitty", "gnome-terminal", "foot"]) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(bin, "konsole"), "not runnable", { mode: 0o644 });
    expect(terminalApps([], "linux", { PATH: `${path.join(root, "missing")}:${bin}`, TERMINAL: "foot" })).toEqual(["foot", "gnome-terminal", "kitty", "none"]);
    expect(terminalApps([], "linux", { PATH: bin, TERMINAL: path.join(bin, "foot") })).toEqual([path.join(bin, "foot"), "gnome-terminal", "kitty", "none"]);
    // a $TERMINAL that is not there is not offered
    expect(terminalApps([], "linux", { PATH: bin, TERMINAL: "st" })).toEqual(["gnome-terminal", "kitty", "none"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("a terminal of herdr", () => {
  it("defaults to automatic and preserves a saved terminal choice", () => {
    expect(TerminalSettings.parse({}).terminal).toBe(AUTO_TERMINAL);
    expect(TerminalSettings.parse({ terminal: "Terminal" }).terminal).toBe("Terminal");
    expect(TerminalSettings.parse({ terminal: "none" }).terminal).toBe("none");
  });

  it("runs the script in herdr, as a tab named for the ticket in the project's workspace", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-terminal-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const launches: Parameters<PaneTerminal["launch"]>[0][] = [];
    const herdr: PaneTerminal = { kind: "herdr", launch: async (input) => { launches.push(input); return { paneId: "w2:p1" }; }, installed: async () => "0.9.5" };
    const launched = await launchTerminal({ cwd: "/work/tom-9", command: "claude", env: { TOMRADE_MCP_TOKEN: "t" }, dir, label: "TOM-9", workspace: { key: "p1", label: "Tomrade" } }, "herdr", herdr);
    expect(launched).toEqual({ script: path.join(dir, "run.command"), launched: true, paneId: "w2:p1" });
    expect(launches).toEqual([{ cwd: "/work/tom-9", label: "TOM-9", command: `bash '${path.join(dir, "run.command")}'`, workspace: { key: "p1", label: "Tomrade" } }]);
    expect(fs.readFileSync(path.join(dir, "run.command"), "utf8")).toContain("export TOMRADE_MCP_TOKEN='t'\nclaude");
    // any other terminal is untouched by herdr being there
    expect(await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "none", herdr)).toEqual({ script: path.join(dir, "run.command"), launched: false });
    expect(launches.length).toBe(1);
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves the Windows pid of the script's shell on Windows, where Git Bash's $$ is an MSYS pid", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-win-pid-"));
    const pidFile = `'${path.join(dir, "pid")}'`;
    await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir, resume: "claude --resume x" }, "none", null, "win32");
    for (const name of ["run.command", "resume.command"]) {
      const written = fs.readFileSync(path.join(dir, name), "utf8");
      expect(written).toContain(`{ cat /proc/$$/winpid 2>/dev/null || echo $$; } > ${pidFile}\n`);
      expect(written).not.toContain(`echo $$ > ${pidFile}`);
    }
    await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "none", null, "darwin");
    expect(fs.readFileSync(path.join(dir, "run.command"), "utf8")).toContain(`\necho $$ > ${pidFile}\n`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("without herdr opens the script in the system terminal, and says why", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-fallback-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const script = path.join(dir, "run.command");
    const stopped: PaneTerminal = { kind: "herdr", launch: async () => null, installed: async () => "0.9.5" };
    const absent: PaneTerminal = { kind: "herdr", launch: async () => null, installed: async () => null };

    const notRunning = await launchTerminal({ cwd: "/work/tom-9", command: "claude", env: { TOMRADE_MCP_TOKEN: "t" }, dir, label: "TOM-9", resume: "claude --resume x" }, "herdr", stopped);
    expect(notRunning).toEqual({ script, launched: true, herdrMissing: "notRunning" });
    expect(opened).toHaveBeenLastCalledWith("Terminal", script, "/work/tom-9");
    // the same script any terminal app gets: the heartbeat, the token and the resume beside it
    const written = fs.readFileSync(script, "utf8");
    expect(written).toContain(process.platform === "win32" ? "/proc/$$/winpid" : "echo $$ >");
    expect(written).toContain("export TOMRADE_MCP_TOKEN='t'\nclaude");
    expect(fs.readFileSync(path.join(dir, "resume.command"), "utf8")).toContain("claude --resume x");
    expect(await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "herdr", absent)).toEqual({ script, launched: true, herdrMissing: "notInstalled" });
    expect(await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "herdr", null)).toEqual({ script, launched: true, herdrMissing: "notInstalled" });
    // engine setup goes the same way
    // On Windows setup opens a PowerShell console of its own, not the script (setupOnWindows has its own tests).
    if (process.platform !== "win32") {
      expect(await setupTerminal("npm i -g x", dir, "herdr", absent)).toEqual({ launched: true });
      expect(opened).toHaveBeenCalledTimes(4);
    }

    // the system terminal failing too leaves the script for the person
    opened.mockRejectedValueOnce(new Error("no app"));
    const failed = await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, "herdr", stopped);
    expect(failed).toEqual({ script, launched: false, herdrMissing: "notRunning" });

    const app = process.platform === "darwin" ? "Terminal" : "the system terminal";
    expect(herdrFallbackNote("en", notRunning)).toBe(`herdr is not running, so this opened in ${app} instead. Start herdr by running \`herdr\` in a terminal.`);
    expect(herdrFallbackNote("en", { script, launched: true, herdrMissing: "notInstalled" })).toContain("install guide");
    expect(herdrFallbackNote("en", failed)).toContain("run the command yourself");
    expect(herdrFallbackNote("zh", notRunning)).toContain("herdr 没有在运行");
    expect(herdrFallbackNote("en", { script, launched: true, paneId: "w1:p1" })).toBeNull();
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("says once that herdr now runs in the background when the launch started its server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-herdr-started-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const starts: ("first" | "again")[] = ["first", "again"];
    const herdr: PaneTerminal = { kind: "herdr", launch: async () => ({ paneId: "w1:p1", startedServer: starts.shift() }), installed: async () => "0.9.5" };
    const first = await launchTerminal({ cwd: "/work", command: "claude", dir }, "herdr", herdr);
    expect(first).toEqual({ script: path.join(dir, "run.command"), launched: true, paneId: "w1:p1", herdrStarted: "first" });
    expect(herdrFallbackNote("en", first)).toBe("herdr is running in the background now. Run `herdr` in a terminal to see its panes.");
    expect(herdrFallbackNote("zh", first)).toContain("herdr 已在后台运行");
    const again = await launchTerminal({ cwd: "/work", command: "claude", dir }, "herdr", herdr);
    expect(again.herdrStarted).toBe("again");
    expect(herdrFallbackNote("en", again)).toBeNull();
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Tomrade's own terminal", () => {
  const bash = "C:\\Program Files\\Git\\bin\\bash.exe";

  it("runs the script through Git Bash in a pane of the host, its shell staying after the agent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-builtin-terminal-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const launches: Parameters<PaneTerminal["launch"]>[0][] = [];
    const host: PaneTerminal = { kind: "builtin", launch: async (input) => { launches.push(input); return { paneId: "p1-1" }; }, installed: async () => "0.20.0" };
    const script = path.join(dir, "run.command");
    const launched = await launchTerminal({ cwd: "C:\\work\\tom-9", command: "claude", dir, label: "TOM-9", workspace: { key: "p1", label: "Tomrade" } }, BUILTIN_TERMINAL, host, "win32", () => bash);
    expect(launched).toEqual({ script, launched: true, paneId: "p1-1" });
    expect(launches).toEqual([{ cwd: "C:\\work\\tom-9", label: "TOM-9", command: `bash '${script}'`, program: { file: bash, args: [script] }, workspace: { key: "p1", label: "Tomrade" } }]);
    expect(fs.readFileSync(script, "utf8")).toContain('exec "${SHELL:-bash}"');
    expect(opened).not.toHaveBeenCalled();
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("opens nothing without Git Bash, and says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-builtin-nobash-"));
    const host: PaneTerminal = { kind: "builtin", launch: async () => ({ paneId: "p1-1" }), installed: async () => "0.20.0" };
    const launched = await launchTerminal({ cwd: dir, command: "claude", dir }, BUILTIN_TERMINAL, host, "win32", () => null);
    expect(launched).toEqual({ script: path.join(dir, "run.command"), launched: false, gitBashMissing: true });
    expect(herdrFallbackNote("en", launched)).toContain("Git Bash");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("goes to the system terminal when the host does not start, and says why", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-builtin-fallback-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    const down: PaneTerminal = { kind: "builtin", launch: async () => null, installed: async () => "0.20.0" };
    const launched = await launchTerminal({ cwd: dir, command: "claude", dir }, BUILTIN_TERMINAL, down, "win32", () => bash);
    expect(launched).toEqual({ script: path.join(dir, "run.command"), launched: true, hostFailed: true });
    expect(opened).toHaveBeenCalledOnce();
    expect(herdrFallbackNote("en", launched)).toMatch(/^Tomrade's terminal host did not start, so this opened in .+ instead.$/);
    expect(herdrFallbackNote("zh", launched)).toContain("终端 host 没能启动");
    // A backend of the other kind is not used for it.
    const herdr: PaneTerminal = { kind: "herdr", launch: async () => ({ paneId: "w1:p1" }), installed: async () => "0.9.5" };
    expect((await launchTerminal({ cwd: dir, command: "claude", dir }, BUILTIN_TERMINAL, herdr, "win32", () => bash)).hostFailed).toBe(true);
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
    expect(TerminalSettings.parse({}).dshCommand).toBe('"{bin}" --profile headless --patch "{dshPatch}" --json {resume} - < "{prompt}" | TOMRADE_PROMPT_FILE="{prompt}" ELECTRON_RUN_AS_NODE=1 "{node}" "{dshReporter}"');
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
    expect(fillTemplate(withOptions(defaults.claudeCommand, ""), { ...values, bin: "/u/bin/claude" })).toBe('"/u/bin/claude" --mcp-config "/s/mcp.json" --settings "/s/settings.json" "$(cat "/s/prompt.md")"');
    expect(fillTemplate(withOptions(defaults.claudeCommand, "--model opus"), { ...values, bin: "claude" })).toBe('"claude" --model opus --mcp-config "/s/mcp.json" --settings "/s/settings.json" "$(cat "/s/prompt.md")"');
    expect(fillTemplate(withOptions(defaults.codexCommand, "-m gpt-5"), { ...values, bin: "codex", resume: "resume abc" })).toMatch(/^"codex" resume abc -m gpt-5 -c mcp_servers/);
    expect(fillTemplate(withOptions(defaults.piCommand, "--thinking high"), { ...values, bin: "/t/global/bin/pi", piExtension: "/s/pi-extension.ts", resume: "--session-id abc" }))
      .toBe('"/t/global/bin/pi" --thinking high -e "/s/pi-extension.ts" --session-id abc "$(cat "/s/prompt.md")"');
    expect(fillTemplate(withOptions(defaults.workbuddyCommand, "--model hy3"), { ...values, bin: "codebuddy", resume: "--resume abc" }))
      .toBe('"codebuddy" --model hy3 --mcp-config "/s/mcp.json" --settings "/s/settings.json" --resume abc "$(cat "/s/prompt.md")"');
    const legacy = 'claude --mcp-config "{mcpConfig}" "$(cat "{prompt}")"';
    expect(withOptions(legacy, "--effort high")).toBe('claude --effort high --mcp-config "{mcpConfig}" "$(cat "{prompt}")"');
    expect(withOptions(legacy, "")).toBe(legacy);
  });
});

describe("Gemini CLI's session home", () => {
  it("is the person's own ~/.gemini, linked, with the server and its hooks added to a copy of its settings", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-gemini-home-"));
    const own = path.join(root, "me", ".gemini");
    fs.mkdirSync(path.join(own, "extensions"), { recursive: true });
    fs.writeFileSync(path.join(own, "oauth_creds.json"), "{}");
    // Gemini reads its settings as JSON with comments.
    fs.writeFileSync(path.join(own, "settings.json"), '{\n  // the person\'s own\n  "theme": "Dracula", /* a "quoted" note */\n  "url": "http://x//y",\n  "mcpServers": { "mine": { "command": "mine" } },\n  "hooks": { "BeforeTool": [{ "matcher": "run_shell_command", "hooks": [{ "type": "command", "command": "./lint.sh" }] }] }\n}\n');
    fs.writeFileSync(path.join(root, "me", ".env"), "GEMINI_API_KEY=k\n");
    const home = path.join(root, "session", "gemini-home");
    const tomrade = { httpUrl: "http://127.0.0.1:1/mcp/p", headers: { "X-Tomrade-Run": "t" } };
    const eventUrl = "http://127.0.0.1:1/sessions/t/event";
    writeGeminiHome(home, { servers: { tomrade }, eventUrl }, own);

    const ownHooks = { BeforeTool: [{ matcher: "run_shell_command", hooks: [{ type: "command", command: "./lint.sh" }] }] };
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"));
    expect(settings).toEqual({ theme: "Dracula", url: "http://x//y", mcpServers: { mine: { command: "mine" }, tomrade }, hooks: geminiHooks(eventUrl, ownHooks) });
    // The person's own hook still runs, before Tomrade's.
    expect(settings.hooks.BeforeTool).toEqual([ownHooks.BeforeTool[0], { hooks: [{ type: "command", name: "tomrade", command: hookCommand(eventUrl), timeout: 5000 }] }]);
    // Windows without the right to make file links gets a copy of a file instead.
    const sameFile = (a: string, b: string) => process.platform === "win32" ? expect(fs.readFileSync(a, "utf8")).toBe(fs.readFileSync(b, "utf8")) : expect(fs.realpathSync(a)).toBe(fs.realpathSync(b));
    sameFile(path.join(home, ".gemini", "oauth_creds.json"), path.join(own, "oauth_creds.json"));
    expect(fs.realpathSync(path.join(home, ".gemini", "extensions"))).toBe(fs.realpathSync(path.join(own, "extensions")));
    sameFile(path.join(home, ".env"), path.join(root, "me", ".env"));
    // The person's own settings are read, never written.
    expect(fs.readFileSync(path.join(own, "settings.json"), "utf8")).toContain("// the person's own");

    // Bound again (a resumed session): laid down afresh, the same way.
    writeGeminiHome(home, { servers: { tomrade: { ...tomrade, headers: { "X-Tomrade-Run": "t2" } } }, eventUrl }, own);
    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8")).mcpServers.tomrade.headers).toEqual({ "X-Tomrade-Run": "t2" });

    // No ~/.gemini yet, or settings Gemini could not read either: the server and its hooks alone.
    writeGeminiHome(home, { servers: { tomrade }, eventUrl }, path.join(root, "nobody", ".gemini"));
    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"))).toEqual({ mcpServers: { tomrade }, hooks: geminiHooks(eventUrl) });
    // Without an address to report to, no hooks.
    writeGeminiHome(home, { servers: { tomrade } }, path.join(root, "nobody", ".gemini"));
    expect(JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"))).toEqual({ mcpServers: { tomrade } });
  });

  it("runs the CLI Tomrade located in every agent's template, and a default saved with the bare name follows it", () => {
    const defaults = TerminalSettings.parse({});
    for (const engine of ["claude-code", "codex", "pi", "workbuddy", "gemini", "opencode", "hermes", "dsh", "agy", "cursor"]) expect(terminalTemplate(defaults, engine)).toContain('"{bin}"');
    const savedBare = TerminalSettings.parse({ piCommand: 'pi {options} -e "{piExtension}" {resume} "$(cat "{prompt}")"', cursorCommand: 'cursor-agent {options} {resume} "$(cat "{prompt}")"' });
    expect(terminalTemplate(savedBare, "pi")).toBe(defaults.piCommand);
    expect(terminalTemplate(savedBare, "cursor")).toBe(defaults.cursorCommand);
    // a command the person changed stays theirs
    const changed = TerminalSettings.parse({ claudeCommand: 'claude --verbose "$(cat "{prompt}")"' });
    expect(terminalTemplate(changed, "claude-code")).toBe('claude --verbose "$(cat "{prompt}")"');
    expect(bareCommand("workbuddy")).toBe("codebuddy");
    expect(bareCommand("fake-code")).toBe("claude");
  });

  it("moves a command saved before Gemini 0.64 onto the session home", () => {
    expect(terminalTemplate(TerminalSettings.parse({}), "gemini")).toBe('GEMINI_CLI_HOME="{geminiHome}" "{bin}" {options} {resume} -i "$(cat "{prompt}")"');
    const saved = TerminalSettings.parse({ geminiCommand: 'GEMINI_CLI_SYSTEM_DEFAULTS_PATH="{geminiSettings}" gemini --yolo {options} {resume} -i "$(cat "{prompt}")"' });
    expect(terminalTemplate(saved, "gemini")).toBe('GEMINI_CLI_HOME="{geminiHome}" gemini --yolo {options} {resume} -i "$(cat "{prompt}")"');
  });
});

// herdr is the default on macOS and Linux; Windows has its own case below.
describe("an unset terminal", () => {
  const herdrThat = (version: string | null) => ({ kind: "herdr" as const, installed: async () => version });

  it("never changes a terminal app of the person's own, or none, herdr installed or not", async () => {
    for (const terminal of ["Warp", "Terminal", "none"]) {
      expect((await machineTerminalSettings({ terminal }, herdrThat("0.9.5"))).terminal).toBe(terminal);
      expect((await machineTerminalSettings({ terminal }, herdrThat(null))).terminal).toBe(terminal);
    }
  });

  it("reads herdr or the built-in terminal picked by name, from when they were choices, as automatic", async () => {
    expect((await machineTerminalSettings({ terminal: "herdr" }, herdrThat("0.9.5"), "darwin")).terminal).toBe("herdr");
    expect((await machineTerminalSettings({ terminal: "herdr" }, herdrThat(null), "darwin")).terminal).toBe(SYSTEM_TERMINAL);
    expect((await machineTerminalSettings({ terminal: BUILTIN_TERMINAL }, herdrThat("0.9.5"), "darwin")).terminal).toBe("herdr");
    expect((await machineTerminalSettings({ terminal: BUILTIN_TERMINAL }, { kind: "builtin", installed: async () => "1" }, "win32")).terminal).toBe(BUILTIN_TERMINAL);
  });

  it("is herdr where herdr is installed, and the system terminal where it is not", async () => {
    expect((await machineTerminalSettings(undefined, herdrThat("0.9.5"), "darwin")).terminal).toBe("herdr");
    expect((await machineTerminalSettings({ terminal: AUTO_TERMINAL }, herdrThat("0.9.5"), "darwin")).terminal).toBe("herdr");
    expect((await machineTerminalSettings(undefined, herdrThat(null), "darwin")).terminal).toBe(SYSTEM_TERMINAL);
    // Without the herdr plugin there is nothing to run herdr through.
    expect((await machineTerminalSettings({}, null)).terminal).toBe(SYSTEM_TERMINAL);
    expect(SYSTEM_TERMINAL).toBe("Terminal");
  });

  it("is Tomrade's own terminal on Windows where its host can run, never herdr", async () => {
    const builtin = (version: string | null) => ({ kind: "builtin" as const, installed: async () => version });
    expect((await machineTerminalSettings(undefined, builtin("0.20.0"), "win32")).terminal).toBe(BUILTIN_TERMINAL);
    // A build without the ConPTY runtime, or without the host's row: the system terminal, as before.
    expect((await machineTerminalSettings(undefined, builtin(null), "win32")).terminal).toBe(SYSTEM_TERMINAL);
    expect((await machineTerminalSettings(undefined, null, "win32")).terminal).toBe(SYSTEM_TERMINAL);
    expect((await machineTerminalSettings(undefined, herdrThat("0.9.5"), "win32")).terminal).toBe(SYSTEM_TERMINAL);
    // herdr stays the default elsewhere.
    expect((await machineTerminalSettings(undefined, herdrThat("0.9.5"), "linux")).terminal).toBe("herdr");
    expect((await machineTerminalSettings(undefined, builtin("0.20.0"), "darwin")).terminal).toBe(SYSTEM_TERMINAL);
  });

  it("follows herdr once it is installed later, with nothing saved in between", async () => {
    let version: string | null = null;
    const herdr = { kind: "herdr" as const, installed: async () => version };
    const stored = { terminal: AUTO_TERMINAL, claudeCommand: "claude" };
    expect(await machineTerminalSettings(stored, herdr, "darwin")).toMatchObject({ terminal: SYSTEM_TERMINAL, claudeCommand: "claude" });
    version = "0.9.5";
    expect(await machineTerminalSettings(stored, herdr, "darwin")).toMatchObject({ terminal: "herdr", claudeCommand: "claude" });
    expect(stored.terminal).toBe(AUTO_TERMINAL);
  });
});

describe("the system terminal on Windows", () => {
  const ENV = { ProgramFiles: "C:\\Program Files", "ProgramFiles(x86)": "C:\\Program Files (x86)", LOCALAPPDATA: "C:\\Users\\mira\\AppData\\Local" };
  /** A spawn that starts what `works` names and fails the rest, recording each try. */
  const spawner = (works: (command: string) => boolean) => {
    const tries: { command: string; args: string[]; cwd?: string; detached?: boolean }[] = [];
    const launch = ((command: string, args: string[], options: { cwd?: string; detached?: boolean }) => {
      tries.push({ command, args, cwd: options.cwd, detached: options.detached });
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => {};
      queueMicrotask(() => (works(command) ? child.emit("spawn") : child.emit("error", new Error(`spawn ${command} ENOENT`))));
      return child;
    }) as unknown as typeof spawn;
    return { tries, launch };
  };

  it("finds Git Bash where Git for Windows installs it, never WSL's bash on PATH", () => {
    const user = "C:\\Users\\mira\\AppData\\Local\\Programs\\Git\\bin\\bash.exe";
    expect(gitBash(ENV, (file) => file === "C:\\Program Files\\Git\\bin\\bash.exe")).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(gitBash(ENV, (file) => file === user)).toBe(user);
    expect(gitBash({ ...ENV, PATH: "C:\\Windows\\System32" }, (file) => file === "C:\\Windows\\System32\\bash.exe")).toBeNull();
    const alias = "C:\\Users\\mira\\AppData\\Local\\Microsoft\\WindowsApps";
    expect(gitBash({ Path: `C:\\WINDOWS\\system32\\;${alias}` }, (file) => file.endsWith("bash.exe"))).toBeNull();
    expect(gitBash({}, () => true)).toBeNull();
  });

  it("finds Git Bash from Scoop, and beside the git or as the bash.exe on PATH", () => {
    const scoop = "C:\\Users\\mira\\scoop\\apps\\git\\current\\bin\\bash.exe";
    expect(gitBash({ ...ENV, USERPROFILE: "C:\\Users\\mira" }, (file) => file === scoop)).toBe(scoop);
    expect(gitBash({ SCOOP: "D:\\scoop" }, (file) => file === "D:\\scoop\\apps\\git\\current\\bin\\bash.exe")).toBe("D:\\scoop\\apps\\git\\current\\bin\\bash.exe");
    // Git on another drive: cmd\git.exe on PATH, bin\bash.exe beside it; PATHEXT names the kinds, Path any case.
    const files = new Set(["D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe", "C:\\Windows\\System32\\bash.exe"]);
    expect(gitBash({ ...ENV, Path: "C:\\Windows\\System32;\"D:\\Tools\\Git\\cmd\"", PATHEXT: ".COM;.EXE" }, (file) => files.has(file))).toBe("D:\\Tools\\Git\\bin\\bash.exe");
    expect(gitBash({ PATH: "E:\\Git\\mingw64\\bin" }, (file) => file === "E:\\Git\\mingw64\\bin\\git.exe" || file === "E:\\Git\\bin\\bash.exe")).toBe("E:\\Git\\bin\\bash.exe");
    // A bash.exe on PATH that is not WSL's, such as Scoop's shim.
    expect(gitBash({ PATH: "C:\\Windows\\System32;C:\\Users\\mira\\scoop\\shims" }, (file) => file.endsWith("bash.exe"))).toBe("C:\\Users\\mira\\scoop\\shims\\bash.exe");
  });

  it("runs the script with Git Bash in Windows Terminal, in the session's folder", async () => {
    const { tries, launch } = spawner(() => true);
    expect(await openOnWindows("C:\\s\\run.command", "C:\\work\\tom-9", "C:\\Git\\bin\\bash.exe", launch)).toBe("Windows Terminal");
    expect(tries).toEqual([{ command: "wt.exe", args: ["-d", "C:\\work\\tom-9", "C:\\Git\\bin\\bash.exe", "C:\\s\\run.command"], cwd: "C:\\work\\tom-9", detached: true }]);
  });

  it("opens Git Bash in a console window of its own when Windows Terminal is missing", async () => {
    const { tries, launch } = spawner((command) => command !== "wt.exe");
    expect(await openOnWindows("C:\\s\\run.command", "C:\\work", "C:\\Git\\bin\\bash.exe", launch)).toBe("Git Bash");
    expect(tries.map((t) => [t.command, ...t.args])).toEqual([
      ["wt.exe", "-d", "C:\\work", "C:\\Git\\bin\\bash.exe", "C:\\s\\run.command"],
      ["C:\\Git\\bin\\bash.exe", "C:\\s\\run.command"]
    ]);
  });

  it("opens a setup command in PowerShell with scripts allowed for that process alone", async () => {
    const { tries, launch } = spawner((command) => command === "powershell.exe");
    expect(await setupOnWindows("npm install -g @earendil-works/pi-coding-agent", launch)).toEqual({ launched: true });
    expect(tries).toEqual([{ command: "powershell.exe", args: ["-NoExit", "-ExecutionPolicy", "Bypass", "-Command", "npm install -g @earendil-works/pi-coding-agent"], cwd: os.homedir(), detached: true }]);
    expect(await setupOnWindows("pi", spawner(() => false).launch)).toEqual({ launched: false });
  });

  it("opens nothing without Git Bash, and says Git for Windows is needed", async () => {
    const { tries, launch } = spawner(() => true);
    await expect(openOnWindows("C:\\s\\run.command", "C:\\work", null, launch)).rejects.toBeInstanceOf(GitBashMissing);
    expect(tries).toEqual([]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-no-git-bash-"));
    const opened = vi.spyOn(terminalApp, "open").mockRejectedValue(new GitBashMissing());
    const script = path.join(dir, "run.command");
    const launched = await launchTerminal({ cwd: "/work/tom-9", command: "claude", dir }, SYSTEM_TERMINAL);
    expect(launched).toEqual({ script, launched: false, gitBashMissing: true });
    expect(opened).toHaveBeenCalledWith(SYSTEM_TERMINAL, script, "/work/tom-9");
    expect(herdrFallbackNote("en", launched)).toContain("Git for Windows");
    expect(herdrFallbackNote("zh", launched)).toContain("Git for Windows");
    // herdr missing too: the herdr note, then why nothing opened
    const both = herdrFallbackNote("en", { ...launched, herdrMissing: "notInstalled" })!;
    expect(both).toContain("herdr is not installed");
    expect(both).toContain("needs Git Bash");
    expect(both).not.toContain("run the command yourself");
    opened.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the system terminal on Linux", () => {
  /** A spawn that starts what `works` names and fails the rest, never exiting, as an emulator holds its window. */
  const spawner = (works: (command: string) => boolean) => {
    const tries: { command: string; args: string[]; cwd?: string; detached?: boolean }[] = [];
    const launch = ((command: string, args: string[], options: { cwd?: string; detached?: boolean }) => {
      tries.push({ command, args, cwd: options.cwd, detached: options.detached });
      const child = new EventEmitter() as EventEmitter & { unref(): void };
      child.unref = () => {};
      queueMicrotask(() => (works(command) ? child.emit("spawn") : child.emit("error", new Error(`spawn ${command} ENOENT`))));
      return child;
    }) as unknown as typeof spawn;
    return { tries, launch };
  };

  it("opens the script detached, as its own argument, without waiting for the window to close", async () => {
    const { tries, launch } = spawner(() => true);
    expect(await openOnLinux("/s/it's/run.command", "/work/tom-9", launch)).toBe("x-terminal-emulator");
    expect(tries).toEqual([{ command: "x-terminal-emulator", args: ["-e", "bash", "/s/it's/run.command"], cwd: "/work/tom-9", detached: true }]);
  });

  it("falls back to gnome-terminal when x-terminal-emulator cannot start, and fails when neither can", async () => {
    const { tries, launch } = spawner((command) => command === "gnome-terminal");
    expect(await openOnLinux("/s/run.command", "/work", launch)).toBe("gnome-terminal");
    expect(tries.map((t) => [t.command, ...t.args])).toEqual([
      ["x-terminal-emulator", "-e", "bash", "/s/run.command"],
      ["gnome-terminal", "--", "bash", "/s/run.command"]
    ]);
    await expect(openOnLinux("/s/run.command", "/work", spawner(() => false).launch)).rejects.toThrow("gnome-terminal ENOENT");
  });

  it("opens the emulator picked by name with its own flag, and the default chain when it cannot start", async () => {
    const args = async (terminal: string) => {
      const { tries, launch } = spawner(() => true);
      expect(await openOnLinux("/s/run.command", "/work", launch, terminal)).toBe(terminal);
      return tries.map((t) => [t.command, ...t.args]);
    };
    expect(await args("kitty")).toEqual([["kitty", "bash", "/s/run.command"]]);
    expect(await args("konsole")).toEqual([["konsole", "-e", "bash", "/s/run.command"]]);
    expect(await args("xfce4-terminal")).toEqual([["xfce4-terminal", "-x", "bash", "/s/run.command"]]);
    expect(await args("alacritty")).toEqual([["alacritty", "-e", "bash", "/s/run.command"]]);
    expect(await args("wezterm")).toEqual([["wezterm", "start", "--", "bash", "/s/run.command"]]);
    expect(await args("gnome-terminal")).toEqual([["gnome-terminal", "--", "bash", "/s/run.command"]]);
    // $TERMINAL as a path: flags by its name; one Tomrade does not know gets -e
    expect(await args("/opt/kitty/bin/kitty")).toEqual([["/opt/kitty/bin/kitty", "bash", "/s/run.command"]]);
    expect(await args("foot")).toEqual([["foot", "-e", "bash", "/s/run.command"]]);
    const { tries, launch } = spawner((command) => command === "x-terminal-emulator");
    expect(await openOnLinux("/s/run.command", "/work", launch, "kitty")).toBe("x-terminal-emulator");
    expect(tries.map((t) => t.command)).toEqual(["kitty", "x-terminal-emulator"]);
  });

  it.skipIf(process.platform === "win32")("says the script ended, its agent with it, in a folder whose path has a space, and starts again without it", async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-exited-")), "Application Support");
    const herdr: PaneTerminal = { kind: "herdr", launch: async () => ({ paneId: "w1:p1" }), installed: async () => "0.9.5" };
    try {
      await launchTerminal({ cwd: os.tmpdir(), command: `test -e '${path.join(dir, "pid")}' && echo running`, dir }, "herdr", herdr, "darwin");
      fs.writeFileSync(path.join(dir, "exited"), "");
      const { execFileSync } = await import("node:child_process");
      // the marker from a run before is gone while it runs; the pid file goes and the marker comes once it ends
      expect(execFileSync("/bin/bash", [path.join(dir, "run.command")], { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim()).toBe("running");
      expect([fs.existsSync(path.join(dir, "pid")), fs.existsSync(path.join(dir, "exited"))]).toEqual([false, true]);
    } finally {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("keeps the window open after the agent, its pid file gone as when the script ends", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-keep-open-"));
    const opened = vi.spyOn(terminalApp, "open").mockResolvedValue();
    try {
      const script = path.join(dir, "run.command");
      const pidFile = path.join(dir, "pid");
      const exitedFile = path.join(dir, "exited");
      const tail = `rm -f '${pidFile}'\n: > '${exitedFile}'\nexec "\${SHELL:-bash}"\n`;
      await launchTerminal({ cwd: dir, command: "echo agent", dir, resume: "echo again" }, SYSTEM_TERMINAL, null, "linux");
      expect(fs.readFileSync(script, "utf8").endsWith(`echo agent\n${tail}`)).toBe(true);
      // herdr's resume runs in a pane that stays anyway
      expect(fs.readFileSync(path.join(dir, "resume.command"), "utf8")).not.toContain("exec");
      // the shell that stays: the agent's pid file already gone, so the session is not kept alive by it
      const shell = path.join(dir, "shell");
      fs.writeFileSync(shell, `#!/bin/sh\ntest -e '${pidFile}' && echo pid-left || echo pid-gone\ntest -e '${exitedFile}' && echo exited\n`, { mode: 0o755 });
      const { execFileSync } = await import("node:child_process");
      expect(execFileSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", SHELL: shell } }).trim().split("\n")).toEqual(["agent", "pid-gone", "exited"]);

      await launchTerminal({ cwd: dir, command: "echo agent", dir }, SYSTEM_TERMINAL, null, "win32");
      expect(fs.readFileSync(script, "utf8")).toContain(tail);
      // macOS Terminal keeps its window; herdr's pane and "none" keep the shell they ran it from
      for (const [terminal, platform] of [[SYSTEM_TERMINAL, "darwin"], ["none", "linux"]] as const) {
        await launchTerminal({ cwd: dir, command: "echo agent", dir }, terminal, null, platform);
        expect(fs.readFileSync(script, "utf8")).not.toContain("exec");
      }
      const herdr: PaneTerminal = { kind: "herdr", launch: async () => ({ paneId: "w1:p1" }), installed: async () => "0.9.5" };
      await launchTerminal({ cwd: dir, command: "echo agent", dir }, "herdr", herdr, "linux");
      expect(fs.readFileSync(script, "utf8")).not.toContain("exec");
      // herdr not answering: the system terminal's window gets the tail
      await launchTerminal({ cwd: dir, command: "echo agent", dir }, "herdr", { kind: "herdr", launch: async () => null, installed: async () => null }, "linux");
      expect(fs.readFileSync(script, "utf8")).toContain(tail);
    } finally {
      opened.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a terminal on a machine without Node", () => {
  it.skipIf(process.platform === "win32")("finds the CLI Tomrade installed, and node through Tomrade's shims, where the bare names are not on PATH", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-terminal-path-"));
    try {
      const prefixBin = path.join(root, "global", "bin");
      const shims = path.join(root, "shims");
      fs.mkdirSync(prefixBin, { recursive: true });
      fs.mkdirSync(shims);
      // npm's bin for a package: a script that needs `node` on PATH.
      fs.writeFileSync(path.join(prefixBin, "pi"), "#!/usr/bin/env node\nconsole.log(`pi ran ${process.argv.slice(2).join(' ')}`);\n", { mode: 0o755 });
      fs.writeFileSync(path.join(shims, "node"), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`, { mode: 0o755 });
      const dirs = terminalPath({ path: path.join(prefixBin, "pi") }, { TOMRADE_NODE_SHIMS: shims }, "darwin");
      expect(dirs).toEqual({ ahead: [prefixBin], behind: [shims] });
      expect(pathExport(dirs, "darwin")).toBe(`export PATH='${prefixBin}':"$PATH":'${shims}'`);

      const dir = path.join(root, "session");
      const { script } = await launchTerminal({ cwd: root, command: locatedCommand("pi login", "pi", path.join(prefixBin, "pi"), "darwin"), dir, path: dirs }, "none");
      const { execFileSync } = await import("node:child_process");
      expect(execFileSync("/bin/bash", [script], { encoding: "utf8", env: { HOME: root, PATH: "/usr/bin:/bin" } }).trim()).toBe("pi ran login");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("names the located file for a sign-in, and gives PowerShell and Git Bash the same folders", () => {
    expect(locatedCommand("opencode auth login", "opencode", "/home/m/.opencode/bin/opencode", "linux")).toBe("'/home/m/.opencode/bin/opencode' auth login");
    expect(locatedCommand("pi", "pi", "C:\\Users\\Mira Q\\AppData\\Roaming\\npm\\pi.cmd", "win32")).toBe("& 'C:\\Users\\Mira Q\\AppData\\Roaming\\npm\\pi.cmd'");
    // not the CLI's own name, or nothing found: the declared command as it is
    expect(locatedCommand("npx some-agent", "some-agent", "/x/some-agent", "darwin")).toBe("npx some-agent");
    expect(locatedCommand("pi", "pi", undefined, "darwin")).toBe("pi");
    expect(terminalPath(null, {}, "darwin")).toEqual({ ahead: [], behind: [] });
    expect(pathExport({ ahead: [], behind: [] }, "darwin")).toBeNull();

    const win = terminalPath({ path: "C:\\Users\\mira\\AppData\\Roaming\\npm\\pi.cmd", pathDirs: ["D:\\tools"] }, { TOMRADE_NODE_SHIMS: "C:\\Users\\mira\\AppData\\Roaming\\Tomrade\\borrowed-node\\bin" }, "win32");
    expect(pathExport(win, "win32")).toBe(`export PATH='/c/Users/mira/AppData/Roaming/npm:/d/tools':"$PATH":'/c/Users/mira/AppData/Roaming/Tomrade/borrowed-node/bin'`);
    expect(powerShellPath(win)).toBe("$env:Path = 'C:\\Users\\mira\\AppData\\Roaming\\npm;' + 'D:\\tools;' + $env:Path + ';C:\\Users\\mira\\AppData\\Roaming\\Tomrade\\borrowed-node\\bin'");
  });
});

describe("a prompt on the command line", () => {
  it("counts bytes per argument on Linux, bytes in all on macOS, and UTF-16 units of the whole line on Windows", () => {
    const rest = '"claude" --mcp-config "/tmp/mcp.json"';
    // Linux: one argument of 128 KiB is refused however little else there is; 3-byte characters count as 3.
    expect(fitsCommandLine(["x".repeat(120_000), rest], "linux")).toBe(true);
    expect(fitsCommandLine(["x".repeat(131_072), rest], "linux")).toBe(false);
    expect(fitsCommandLine(["中".repeat(44_000), rest], "linux")).toBe(false);
    // macOS: up to about 1 MiB, with room left for the environment.
    expect(fitsCommandLine(["x".repeat(600_000), rest], "darwin")).toBe(true);
    expect(fitsCommandLine(["x".repeat(900_000), rest], "darwin")).toBe(false);
    // Windows: the whole line in UTF-16 units, where a CJK character is one and an escaped quote two.
    expect(fitsCommandLine(["中".repeat(30_000), rest], "win32")).toBe(true);
    expect(fitsCommandLine(["x".repeat(32_000), rest], "win32")).toBe(false);
    expect(fitsCommandLine(['"'.repeat(16_000), rest], "win32")).toBe(false);
  });

  it("knows a template that passes the prompt's text from one that reads its file", () => {
    for (const key of ["claudeCommand", "codexCommand", "geminiCommand", "opencodeCommand", "cursorCommand"] as const) expect(promptAsArgument(TerminalSettings.parse({})[key])).toBe(true);
    expect(promptAsArgument("aider --message \"$(<{prompt})\"")).toBe(true);
    for (const key of ["hermesCommand", "dshCommand"] as const) expect(promptAsArgument(TerminalSettings.parse({})[key])).toBe(false);
  });
});
