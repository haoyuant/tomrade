/**
 * The committed hooks run in whatever shell each agent picks: sh, bash or
 * zsh elsewhere, Git Bash or PowerShell on Windows. Here they run for real
 * against a stub Tomrade; PowerShell only where this machine has it.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hookCommand, hooksSettings, writeConnectFiles } from "@tomradex/code-link";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-hook-shells-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const payload = JSON.stringify({ session_id: "s1", hook_event_name: "SessionStart", cwd: "/repo", prompt: "héllo 你好" }) + "\n";
const powershell = ["pwsh", "powershell"].find((name) => spawnSync(name, ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore", timeout: 30_000 }).status === 0);

interface Heard { headers: http.IncomingHttpHeaders; body: string }
const REPLY = JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "stop" } });

/** A Tomrade that answers as the real one does, and the address of one that is down. */
async function stub(): Promise<{ url: string; down: string; heard: Heard[]; close: () => void }> {
  const heard: Heard[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      heard.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" }).end(REPLY);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const closed = http.createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  const downPort = (closed.address() as { port: number }).port;
  await new Promise((resolve) => closed.close(resolve));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/sessions/event`, down: `http://127.0.0.1:${downPort}/sessions/event`, heard, close: () => server.close() };
}

function run(program: string, args: string[], options: { cwd?: string; stdin?: string; pane?: string; terminal?: string; wt?: string } = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const child = spawn(program, args, { cwd: options.cwd, env: { ...process.env, HERDR_PANE_ID: options.pane ?? "", TERM_PROGRAM: options.terminal ?? "", WT_SESSION: options.wt ?? "" } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(options.stdin ?? "");
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr, ms: Date.now() - started })));
}

describe("the committed hook command", () => {
  it("takes only what sh and PowerShell read alike", () => {
    const command = hookCommand("http://127.0.0.1:19090/sessions/event", "codex");
    // Double quotes only; no `||`, file redirection or `/dev/null`, which one of them lacks.
    expect(command.replaceAll("2>&1", "")).not.toMatch(/'|\|\||>|\/dev\/null/);
    expect(command).toMatch(/^set tomrade "\$\(Remove-Item Alias:curl -Force -ErrorAction Ignore 2>&1\)"; set tomrade "\$\(curl -s -m 2 -X POST .* 2>&1\)"; exit 0$/);
    expect(command).toContain(`-H "Content-Type: application/json" -H "X-Tomrade-Herdr-Pane: $HERDR_PANE_ID" -H "X-Tomrade-Terminal: $TERM_PROGRAM" -H "X-Tomrade-WT: $WT_SESSION" -H "X-Tomrade-Agent: codex" --data-binary "@-" "http://127.0.0.1:19090/sessions/event"`);
    expect(hookCommand("http://127.0.0.1:19090/sessions/event")).not.toContain("X-Tomrade-Agent");
    // Nothing in the address can expand in either shell.
    expect(hookCommand('http://127.0.0.1:1/a$b`c"d\\e')).toContain('"http://127.0.0.1:1/a%24b%60c%22d%5Ce"');
  });

  it.skipIf(process.platform === "win32")("posts the payload under sh -c, says nothing and exits 0, and gives up as quietly when Tomrade is down", async () => {
    const tomrade = await stub();
    try {
      const sent = await run("sh", ["-c", hookCommand(tomrade.url, "codex")], { stdin: payload, pane: "w1-2", terminal: "iTerm.app", wt: "6a3f-wt" });
      expect(sent).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(tomrade.heard).toHaveLength(1);
      expect(tomrade.heard[0]!.body).toBe(payload);
      expect(tomrade.heard[0]!.headers).toMatchObject({ "content-type": "application/json", "x-tomrade-agent": "codex", "x-tomrade-herdr-pane": "w1-2", "x-tomrade-terminal": "iTerm.app", "x-tomrade-wt": "6a3f-wt" });
      const down = await run("sh", ["-c", hookCommand(tomrade.down, "codex")], { stdin: payload });
      expect(down).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(down.ms).toBeLessThan(3000);
    } finally {
      tomrade.close();
    }
  }, 30_000);

  it.skipIf(!powershell)("posts the same under PowerShell, and exits 0 when Tomrade is down", async () => {
    const tomrade = await stub();
    try {
      const sent = await run(powershell!, ["-NoProfile", "-Command", hookCommand(tomrade.url)], { stdin: payload });
      expect(sent).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(tomrade.heard).toHaveLength(1);
      expect(tomrade.heard[0]!.body).toBe(payload);
      expect(tomrade.heard[0]!.headers["content-type"]).toBe("application/json");
      expect(await run(powershell!, ["-NoProfile", "-Command", hookCommand(tomrade.down)], { stdin: payload })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    } finally {
      tomrade.close();
    }
  }, 60_000);
});

describe("the hooks of a session Tomrade started", () => {
  const command = (url: string) => (hooksSettings(url) as { hooks: Record<string, { hooks: { command: string }[] }[]> }).hooks.PreToolUse![0]!.hooks[0]!.command;

  it.skipIf(process.platform === "win32")("post the payload under sh -c and leave Tomrade's answer for the agent, and exit 0 when Tomrade is down", async () => {
    const tomrade = await stub();
    try {
      const sent = await run("sh", ["-c", command(tomrade.url)], { stdin: payload, pane: "w1-2" });
      expect(sent).toMatchObject({ code: 0, stdout: REPLY, stderr: "" });
      expect(tomrade.heard.map((heard) => [heard.body, heard.headers["x-tomrade-herdr-pane"]])).toEqual([[payload, "w1-2"]]);
      expect(await run("sh", ["-c", command(tomrade.down)], { stdin: payload })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    } finally {
      tomrade.close();
    }
  }, 30_000);

  it.skipIf(!powershell)("do the same under PowerShell", async () => {
    const tomrade = await stub();
    try {
      const sent = await run(powershell!, ["-NoProfile", "-Command", command(tomrade.url)], { stdin: payload });
      expect(sent.code).toBe(0);
      expect(sent.stdout.trim()).toBe(REPLY);
      expect(tomrade.heard.map((heard) => heard.body)).toEqual([payload]);
      expect(await run(powershell!, ["-NoProfile", "-Command", command(tomrade.down)], { stdin: payload })).toMatchObject({ code: 0, stdout: "", stderr: "" });
    } finally {
      tomrade.close();
    }
  }, 60_000);
});

describe("Cursor's hook scripts", () => {
  const input = (eventUrl: string) => ({ projectName: "App", mcpUrl: "http://127.0.0.1:19090/mcp/p1", eventUrl, prefix: "APP", branchTemplate: "{key}/{slug}" });

  it.skipIf(process.platform === "win32")("run by their path, post the payload as Cursor", async () => {
    const tomrade = await stub();
    const dir = fs.mkdtempSync(path.join(root, "cursor-"));
    try {
      writeConnectFiles(dir, input(tomrade.url), ["cursor"]);
      const sent = await run(path.join(dir, ".cursor/hooks/tomrade"), [], { cwd: dir, stdin: payload });
      expect(sent).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(tomrade.heard.map((heard) => [heard.body, heard.headers["x-tomrade-agent"]])).toEqual([[payload, "cursor"]]);
    } finally {
      tomrade.close();
    }
  }, 30_000);

  it.skipIf(!powershell)("on Windows, get the payload piped into the PowerShell one as Cursor does", async () => {
    const tomrade = await stub();
    const dir = fs.mkdtempSync(path.join(root, "cursor-ps-"));
    try {
      writeConnectFiles(dir, input(tomrade.url), ["cursor"]);
      fs.writeFileSync(path.join(dir, "payload.json"), payload);
      // cursor-agent 2026.10.16 on Windows: the payload from a file, piped through $input.
      const wrapper = "Get-Content -LiteralPath 'payload.json' -Raw -Encoding UTF8 | & { $input | & '.cursor/hooks/tomrade.ps1' }";
      const sent = await run(powershell!, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", wrapper], { cwd: dir, pane: "w1-2" });
      expect(sent).toMatchObject({ code: 0, stdout: "", stderr: "" });
      expect(tomrade.heard).toHaveLength(1);
      expect(tomrade.heard[0]!.body).toBe(payload);
      expect(tomrade.heard[0]!.headers).toMatchObject({ "content-type": "application/json", "x-tomrade-agent": "cursor", "x-tomrade-herdr-pane": "w1-2" });
    } finally {
      tomrade.close();
    }
  }, 60_000);
});
