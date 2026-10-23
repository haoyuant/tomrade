/**
 * The shell plugin: one command per process group, bounded by its timeout and
 * by the run, read back as exit code + shortened output — and, unless the
 * person chose otherwise, run only after they approve it. Never over MCP.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fresh } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { Agent } from "@tomradex/agent";
import { fakeChat, type ChatEvent, type ChatModel, type ChatRequest } from "@tomradex/llm";
import loop from "@tomradex/engine-loop";
import shell, { SHELL_SECTION, findBash, orphanSweep, plain, runShell } from "@tomradex/shell";

const bash = "/bin/bash";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("findBash", () => {
  const on = (...files: string[]) => (file: string) => files.includes(file);

  it("finds Git Bash in its install folder, beside a git on PATH, or on PATH — never WSL's", () => {
    const env = { ProgramFiles: "C:\\Program Files", USERPROFILE: "C:\\Users\\a", Path: "C:\\WINDOWS\\system32;D:\\Git\\cmd;C:\\tools\\msys\\usr\\bin" };
    expect(findBash("win32", env, on("C:\\Program Files\\Git\\bin\\bash.exe", "D:\\Git\\bin\\bash.exe"))).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(findBash("win32", env, on("C:\\Users\\a\\scoop\\apps\\git\\current\\bin\\bash.exe"))).toBe("C:\\Users\\a\\scoop\\apps\\git\\current\\bin\\bash.exe");
    expect(findBash("win32", env, on("D:\\Git\\cmd\\git.exe", "D:\\Git\\bin\\bash.exe"))).toBe("D:\\Git\\bin\\bash.exe");
    expect(findBash("win32", env, on("C:\\WINDOWS\\system32\\bash.exe", "C:\\tools\\msys\\usr\\bin\\bash.exe"))).toBe("C:\\tools\\msys\\usr\\bin\\bash.exe");
    expect(findBash("win32", { Path: "C:\\Windows\\System32" }, on("C:\\Windows\\System32\\bash.exe"))).toBeNull();
  });

  it("looks on PATH when bash is not in a usual place (NixOS, Guix)", () => {
    expect(findBash("linux", { PATH: "/run/current-system/sw/bin:/usr/sbin" }, on("/run/current-system/sw/bin/bash"))).toBe("/run/current-system/sw/bin/bash");
    expect(findBash("linux", { PATH: "/usr/bin" }, on("/bin/bash", "/usr/bin/bash"))).toBe("/bin/bash");
    expect(findBash("linux", {}, on())).toBeNull();
  });
});

describe("orphanSweep", () => {
  it("walks the dead root's children born after it, and spares the root's pid", () => {
    const script = orphanSweep(4242, 1_700_000_000_000);
    expect(script).toContain("$tree.Add(4242)");
    expect(script).toContain("FromUnixTimeMilliseconds(1699999999000)");
    expect(script).toContain("Select-Object -Skip 1");
  });
});

describe.skipIf(process.platform === "win32")("runShell", () => {
  const cwd = fs.realpathSync(os.tmpdir());

  it("reports the exit code with stdout and stderr together, in the folder and env it was given", async () => {
    const result = await runShell('echo "out $FOO"; pwd -P; echo err >&2; exit 3', { bash, cwd, env: { FOO: "bar" } });
    expect(result).toMatchObject({ exitCode: 3, timedOut: false, cancelled: false });
    expect(result.output).toContain("out bar");
    expect(result.output).toContain(cwd);
    expect(result.output).toContain("err");
  });

  it("stops a command at its timeout and keeps what it printed", async () => {
    const t0 = Date.now();
    const result = await runShell("echo started; sleep 30", { bash, cwd, timeoutS: 1 });
    expect(result.timedOut).toBe(true);
    expect(result.output).toContain("started");
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it("stops when the run is cancelled", async () => {
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 200);
    const result = await runShell("sleep 30", { bash, cwd, signal: abort.signal });
    expect(result.cancelled).toBe(true);
  });

  it("leaves nothing running in the background", async () => {
    const result = await runShell("sleep 30 >/dev/null 2>&1 & echo $!", { bash, cwd });
    const pid = Number(result.output.trim());
    expect(pid).toBeGreaterThan(0);
    await expect.poll(() => alive(pid)).toBe(false);
  });

  it("returns even when a background child holds the output open", async () => {
    const t0 = Date.now();
    const result = await runShell("echo hi; sleep 30 &", { bash, cwd });
    expect(result.exitCode).toBe(0);
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("keeps the head and the tail of a long output", async () => {
    const result = await runShell("seq 1 100000", { bash, cwd });
    expect(result.output.startsWith("1\n2\n3\n")).toBe(true);
    expect(result.output.trimEnd().endsWith("100000")).toBe(true);
    expect(result.output).toMatch(/… \(\d+ characters omitted\) …/);
    expect(result.output.length).toBeLessThan(17_000);
  });

  it("reads terminal output as text", () => {
    expect(plain("\x1b[32mok\x1b[0m\n 10%\r 50%\r100%\nend\r\n")).toBe("ok\n100%\nend\n");
  });
});

describe.skipIf(process.platform === "win32")("the bash tool in a loop turn", () => {
  async function boot(model: ChatModel, root: string) {
    return fresh({ plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], loop, shell] });
  }

  async function drive(steps: ChatEvent[][], opts: { approval?: "ask" | "auto"; cwd?: boolean; answers?: string[] } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-shell-")));
    const work = path.join(root, "work");
    fs.mkdirSync(work);
    const requests: ChatRequest[] = [];
    let step = 0;
    const model: ChatModel = {
      capabilities: { tools: true, streaming: true, json: true },
      async *chat(request) {
        requests.push(structuredClone(request));
        for (const ev of steps[step++] ?? [{ type: "stop", reason: "end" }]) yield ev;
      }
    };
    const { ctx, project } = await boot(model, root);
    if (opts.approval) ctx.settings.set({ ...ctx.settings.get(), shell: { approval: opts.approval } });
    if (opts.cwd !== false) ctx.on("agent/prepare-turn", (input) => void (input.cwd = work));
    const thread = ctx.agent.newThread(project.id, "loop");
    const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "go" });
    const asked: string[] = [];
    for (const answer of opts.answers ?? []) {
      await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.kind).toBe("permission");
      const question = ctx.agent.thread(project.id, thread.id).pending!.question;
      asked.push(question.text);
      ctx.agent.send(project.id, thread.id, { kind: "answer", questionId: question.id, value: answer });
      await expect.poll(() => ctx.agent.thread(project.id, thread.id).pending?.question.id).not.toBe(question.id);
    }
    await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).not.toBe("running");
    const status = ctx.agent.store.run(project.id, run.runId)?.status;
    const traces = ctx.agent.thread(project.id, thread.id).messages.flatMap((m) => (m.block.type === "trace" ? [m.block] : []));
    await ctx.fiber.dispose();
    const files = fs.readdirSync(work);
    fs.rmSync(root, { recursive: true, force: true });
    const toolResult = (i: number) => (requests[i]!.messages.at(-1)!.content.find((c) => c.type === "tool_result") as { content: string } | undefined)?.content;
    return { requests, status, traces, asked, files, work, toolResult };
  }
  const bashCall = (id: string, command: string): ChatEvent[] => [{ type: "tool_call", id, name: "bash", args: { command } }, { type: "stop", reason: "tool_use" }];

  it("runs without asking when the person chose so, in the thread's folder, and reads the output back as text", async () => {
    const { status, requests, traces, toolResult, work } = await drive([bashCall("a", "pwd -P && echo hello > note.txt && cat note.txt")], { approval: "auto" });
    expect(status).toBe("done");
    const tool = requests[0]!.tools!.find((t) => t.name === "bash");
    expect(tool?.description).not.toContain("waits for the user's approval");
    expect(toolResult(1)).toBe(`exit 0\n${work}\nhello`);
    expect(traces).toEqual([expect.objectContaining({ tool: "bash", ok: true })]);
  });

  it("asks first by default: a denied command never runs and the model hears why", async () => {
    const { status, asked, files, toolResult, traces, requests } = await drive([bashCall("a", "touch denied.txt")], { answers: ["Deny"] });
    expect(status).toBe("done");
    expect(requests[0]!.tools!.find((t) => t.name === "bash")?.description).toContain("waits for the user's approval");
    expect(asked).toEqual([expect.stringContaining("touch denied.txt")]);
    expect(files).toEqual([]);
    expect(toolResult(1)).toMatch(/declined/);
    expect(traces).toEqual([expect.objectContaining({ tool: "bash", ok: false })]);
  });

  it("asks once when the person allows the rest of the turn, and runs same-step commands one at a time", async () => {
    const { status, asked, files } = await drive(
      [
        [
          { type: "tool_call", id: "a", name: "bash", args: { command: "touch one.txt" } },
          { type: "tool_call", id: "b", name: "bash", args: { command: "test -f one.txt && touch two.txt" } },
          { type: "stop", reason: "tool_use" }
        ],
        bashCall("c", "touch three.txt")
      ],
      { answers: ["Allow for this turn"] }
    );
    expect(status).toBe("done");
    expect(asked).toHaveLength(1);
    expect(files.sort()).toEqual(["one.txt", "three.txt", "two.txt"]);
  });

  it("says so when the conversation has nowhere to run", async () => {
    const { toolResult } = await drive([bashCall("a", "ls")], { cwd: false, approval: "auto" });
    expect(toolResult(1)).toMatch(/no folder to run in/);
  });

  it("is registered only while switched on, is never served over MCP, and no agent may change it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-shell-"));
    const { ctx } = await boot({ capabilities: { tools: true, streaming: true, json: true }, async *chat() {} }, root);
    try {
      expect(ctx.tools.has("bash")).toBe(true);
      expect(ctx.tools.served().map((t) => t.name)).not.toContain("bash");
      expect(ctx.settings.accessOf(SHELL_SECTION)).toBe("none");
      ctx.settings.set({ ...ctx.settings.get(), shell: { approval: "off" } });
      expect(ctx.tools.has("bash")).toBe(false);
      ctx.settings.set({ ...ctx.settings.get(), shell: { approval: "auto" } });
      expect(ctx.tools.has("bash")).toBe(true);
      await expect(ctx.tools.execute("bash", { command: "echo hi" }, { by: "human" })).rejects.toThrow(/only inside an assistant conversation/);
    } finally {
      await ctx.fiber.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
