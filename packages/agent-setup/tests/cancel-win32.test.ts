import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A child that never ends by itself: only what cancel does to it closes it. */
function fakeChild(pid: number) {
  const child = Object.assign(new EventEmitter(), { pid, exitCode: null, signalCode: null, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn() });
  return child;
}

const spawned: { command: string; args: string[] }[] = [];
const npm = fakeChild(4242);

vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: (command: string, args: string[]) => {
    spawned.push({ command, args });
    if (command !== "taskkill") return npm;
    // taskkill /T takes the tree down: npm's shell and node with it.
    setTimeout(() => npm.emit("close", 1), 0);
    return new EventEmitter();
  }
}));

const { bareLaunch, runCommand } = await import("../src/run.js");

describe("cancel on Windows", () => {
  const platform = process.platform;
  afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

  it("takes npm's whole process tree down with taskkill /T /F", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    const abort = new AbortController();
    const run = runCommand(bareLaunch("npm.cmd"), ["install", "-g", "@x/cli"], { signal: abort.signal, timeoutMs: 30_000 });
    abort.abort();
    const end = await run;
    expect(spawned.at(-1)).toEqual({ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] });
    expect(npm.kill).not.toHaveBeenCalled();
    expect(end).toMatchObject({ code: null, error: { message: "cancelled", killed: true } });
  });
});
