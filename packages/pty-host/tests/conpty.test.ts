import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostCall, openTerminal } from "../src/client.js";
import { killTree, scanProcesses, spawnConpty } from "../src/conpty.js";
import { Host, serve } from "../src/host.js";
import { conptyRuntime } from "../src/index.js";

/** Real pseudoconsoles: only where the ConPTY runtime is, which is Windows with node-pty's prebuilds. */
const conpty = process.platform === "win32" && !!conptyRuntime();

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const bash = ["ProgramFiles", "ProgramFiles(x86)"].map((v) => process.env[v] && path.join(process.env[v]!, "Git", "bin", "bash.exe")).find((f): f is string => !!f && fs.existsSync(f));

const servers: net.Server[] = [];
const hosts: Host[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

async function realHost() {
  const host = new Host({ spawn: spawnConpty, shell: () => ({ file: "cmd.exe", args: [] }), killTree, scan: () => scanProcesses(), scanTiming: { minMs: 0, staleMs: 0, soonMs: 0 }, version: "test", idleMs: 60_000, onIdle: () => undefined });
  hosts.push(host);
  const pipe = `\\\\.\\pipe\\tomrade-pty-conpty-${process.pid}-${hosts.length}`;
  servers.push(await serve(host, pipe));
  return { host, pipe };
}

async function screenOf(pipe: string, paneId: string) {
  const stream = openTerminal(pipe, { paneId, mode: "control", cols: 100, rows: 20 });
  let text = "";
  stream.onFrame((f) => (text += Buffer.from(f.bytes).toString("utf8")));
  await stream.attached;
  return { stream, text: () => text };
}

describe.skipIf(!conpty)("panes on ConPTY", () => {
  it("ends the whole process tree when a pane closes", async () => {
    const { pipe } = await realHost();
    const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log('child='+c.pid);setInterval(()=>{},1000)";
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir(), file: process.execPath, args: ["-e", script], env: { ...process.env } as Record<string, string> });
    const pane = await screenOf(pipe, pane_id);
    let child = 0;
    await vi.waitFor(() => {
      child = Number(/child=(\d+)/.exec(pane.text())?.[1]);
      expect(child).toBeGreaterThan(0);
    }, { timeout: 15_000 });
    expect(alive(child)).toBe(true);
    const { panes } = await hostCall<{ panes: { pid: number }[] }>(pipe, "pane.list");
    const root = panes[0]!.pid;
    await hostCall(pipe, "pane.close", { pane_id }, 15_000);
    await vi.waitFor(() => expect([alive(root), alive(child)]).toEqual([false, false]), { timeout: 10_000 });
    pane.stream.close();
  }, 30_000);

  it("lists what runs under a pane from Windows' process table", async () => {
    const { pipe } = await realHost();
    const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: os.tmpdir(), command: "ping -n 60 127.0.0.1", env: { ...process.env } as Record<string, string> });
    await vi.waitFor(async () => {
      const { process_info } = await hostCall<{ process_info: { foreground_processes: { name: string; cmdline: string }[] } }>(pipe, "pane.process_info", { pane_id });
      expect(process_info.foreground_processes).toContainEqual(expect.objectContaining({ cmdline: "ping -n 60 127.0.0.1" }));
    }, { timeout: 20_000, interval: 500 });
    await hostCall(pipe, "pane.close", { pane_id }, 15_000);
  }, 40_000);

  it.skipIf(!bash)("runs a session's bash script through Git Bash, which sees its pane", async () => {
    const { pipe } = await realHost();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-conpty-"));
    const script = path.join(dir, "run.command");
    fs.writeFileSync(script, '#!/bin/bash\necho "pane=$HERDR_PANE_ID"\nexec bash\n');
    try {
      const { pane_id } = await hostCall<{ pane_id: string }>(pipe, "pane.launch", { cwd: dir, file: bash, args: [script], env: { ...process.env } as Record<string, string> });
      const pane = await screenOf(pipe, pane_id);
      await vi.waitFor(() => expect(pane.text()).toContain(`pane=${pane_id}`), { timeout: 20_000 });
      await hostCall(pipe, "pane.close", { pane_id }, 15_000);
      pane.stream.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40_000);
});
