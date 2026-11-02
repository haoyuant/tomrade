import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { spawnCliTree, stopCli, stopCliNow, type CliLaunch } from "../src/locate.js";

const INNER = `process.on("SIGTERM", () => {}); process.stdout.write(process.pid + "\\n"); setInterval(() => {}, 1000);`;
const OUTER = (inner: string) => `require("node:child_process").spawn(process.execPath, [${JSON.stringify(inner)}], { stdio: "inherit" }); setInterval(() => {}, 1000);`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number) => {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
  return !alive(pid);
};

describe.skipIf(process.platform === "win32")("an agent that runs itself again as a child", () => {
  const dirs: string[] = [];
  const started: number[] = [];
  afterEach(() => {
    for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function start(run: typeof spawnCliTree = spawnCliTree): Promise<{ child: ChildProcess; inner: number }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-tree-"));
    dirs.push(dir);
    const inner = path.join(dir, "inner.cjs");
    const outer = path.join(dir, "outer.cjs");
    fs.writeFileSync(inner, INNER);
    fs.writeFileSync(outer, OUTER(inner));
    const launch: CliLaunch = { file: outer, argv: (args) => ({ command: process.execPath, args: [outer, ...args] }), env: (base) => base ?? process.env };
    const child = run(launch, [], { stdio: ["pipe", "pipe", "pipe"] });
    const pid = await new Promise<number>((resolve) => child.stdout!.once("data", (chunk) => resolve(Number(String(chunk).trim()))));
    started.push(pid);
    return { child, inner: pid };
  }

  it("is stopped whole, though the child ignores SIGTERM and the one Tomrade started is already gone", async () => {
    const { child, inner } = await start();
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill("SIGKILL");
    });
    expect(alive(inner)).toBe(true);
    stopCli(child, "SIGKILL");
    expect(await gone(inner)).toBe(true);
  });

  it("is stopped whole as Tomrade quits", async () => {
    const { child, inner } = await start();
    stopCliNow(child, "SIGKILL");
    expect(await gone(inner)).toBe(true);
  });

  it("leaves a stopped group alone", async () => {
    const { child, inner } = await start();
    stopCli(child, "SIGKILL");
    await gone(inner);
    expect(() => stopCli(child, "SIGKILL")).not.toThrow();
  });

  it("needs the group: signalling only the process started leaves the child running", async () => {
    const plain: typeof spawnCliTree = (launch, args, options) => {
      const spec = launch.argv(args);
      return spawn(spec.command, spec.args, options ?? {});
    };
    const { child, inner } = await start(plain);
    stopCli(child, "SIGKILL");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(inner)).toBe(true);
  });
});
