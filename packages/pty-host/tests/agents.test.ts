import { describe, expect, it } from "vitest";
import { agentIn, agentOfProcess, descendants, parseProcessTable, shortCommand, strippedTitle, titleStatus, type ProcessRow } from "../src/agents.js";

const row = (pid: number, ppid: number, name: string, cmdline = "", created = pid * 10): ProcessRow => ({ pid, ppid, created, name, cmdline });

describe("the process table", () => {
  it("reads the scan's tab-separated lines, keeping tabs inside a command line and skipping noise", () => {
    const text = ["10\t1\t100\tpwsh.exe\t\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\" -NoLogo", "", "garbage", "11\t10\t0\tclaude.exe\tclaude\t--resume x", "0\t0\t0\tSystem Idle Process\t"].join("\r\n");
    expect(parseProcessTable(text)).toEqual([
      { pid: 10, ppid: 1, created: 100, name: "pwsh.exe", cmdline: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo' },
      { pid: 11, ppid: 10, created: 0, name: "claude.exe", cmdline: "claude\t--resume x" }
    ]);
  });

  it("walks a pane's root down, nearest and newest first, without the console's own processes", () => {
    const rows = [
      row(1, 0, "explorer.exe"),
      row(10, 1, "pwsh.exe"),
      row(11, 10, "OpenConsole.exe"),
      row(12, 10, "conhost.exe"),
      row(20, 10, "git.exe"),
      row(30, 10, "claude.exe"),
      row(40, 30, "bash.exe"),
      row(50, 40, "rg.exe")
    ];
    expect(descendants(rows, 10).map((r) => r.pid)).toEqual([30, 20, 40, 50]);
  });

  it("does not take a process whose parent's pid was reused by a younger one", () => {
    // 7 started under an earlier process 10 that has gone; the pane's root got pid 10 later.
    const rows = [row(10, 1, "pwsh.exe", "", 500), row(7, 10, "stray.exe", "", 100), row(8, 10, "child.exe", "", 600)];
    expect(descendants(rows, 10).map((r) => r.pid)).toEqual([8]);
  });

  it("survives a cycle in the table", () => {
    expect(descendants([row(10, 11, "a.exe", "", 0), row(11, 10, "b.exe", "", 0)], 10).map((r) => r.pid)).toEqual([11]);
  });
});

describe("a pane's agent", () => {
  it("is known by its executable, whatever the case or extension", () => {
    expect(agentOfProcess({ name: "claude.exe", cmdline: "" })).toBe("claude");
    expect(agentOfProcess({ name: "Codex.EXE", cmdline: "" })).toBe("codex");
    expect(agentOfProcess({ name: "cursor-agent.exe", cmdline: "" })).toBe("cursor");
    expect(agentOfProcess({ name: "git.exe", cmdline: "git status" })).toBeNull();
  });

  it("is known by its npm package when Node or Bun runs it", () => {
    expect(agentOfProcess({ name: "node.exe", cmdline: '"C:\\Program Files\\nodejs\\node.exe" C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js' })).toBe("claude");
    expect(agentOfProcess({ name: "node.exe", cmdline: "node C:/npm/node_modules/@google/gemini-cli/dist/index.js" })).toBe("gemini");
    expect(agentOfProcess({ name: "bun.exe", cmdline: "bun C:\\x\\node_modules\\opencode-ai\\bin\\opencode" })).toBe("opencode");
    expect(agentOfProcess({ name: "node.exe", cmdline: "node server.js --name claude-code" })).toBeNull();
    // A package path only counts for a script runner.
    expect(agentOfProcess({ name: "code.exe", cmdline: "code C:\\x\\node_modules\\@openai\\codex\\README.md" })).toBeNull();
  });

  it("is the root's own, else the nearest one under it", () => {
    expect(agentIn(row(10, 1, "codex.exe"), [row(11, 10, "claude.exe")])).toBe("codex");
    expect(agentIn(row(10, 1, "pwsh.exe"), [row(11, 10, "cmd.exe"), row(12, 11, "claude.exe"), row(13, 12, "codex.exe")])).toBe("claude");
    expect(agentIn(undefined, [])).toBeNull();
  });

  it("names a command by its program alone", () => {
    expect(shortCommand({ name: "claude.exe", cmdline: '"C:\\Users\\me\\.local\\bin\\claude.exe" --resume abc' })).toBe("claude --resume abc");
    expect(shortCommand({ name: "vim.exe", cmdline: "C:\\tools\\vim.exe  notes.md" })).toBe("vim notes.md");
    expect(shortCommand({ name: "less.exe", cmdline: "" })).toBe("less");
    expect(shortCommand({ name: "x.exe", cmdline: '"C:\\odd path\\x.exe' })).toBe("x");
  });
});

describe("an agent's title", () => {
  it("reads Claude's spinner as working, and nothing else as anything", () => {
    expect(titleStatus("claude", "⠂ Fixing the parser")).toBe("working");
    expect(titleStatus("claude", "◐ Fixing the parser")).toBe("working");
    expect(titleStatus("claude", "✳ Fixing the parser")).toBe("unknown");
    expect(titleStatus("codex", "⠂ busy")).toBe("unknown");
    expect(titleStatus("claude", null)).toBe("unknown");
  });

  it("drops the glyph an agent leads its title with", () => {
    expect(strippedTitle("⠂ Fixing the parser")).toBe("Fixing the parser");
    expect(strippedTitle("✳ Claude Code")).toBe("Claude Code");
    expect(strippedTitle("Fixing ✳ things")).toBe("Fixing ✳ things");
    expect(strippedTitle("⠂ ")).toBeNull();
    expect(strippedTitle(null)).toBeNull();
  });
});
