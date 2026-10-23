import { afterEach, expect, it, vi } from "vitest";

const ran: { command: string; args: string[] }[] = [];
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawnSync: (command: string, args: string[]) => {
    ran.push({ command, args });
    return { status: 0 };
  }
}));

const { stopCliNow } = await import("../src/locate.js");
const platform = process.platform;
afterEach(() => Object.defineProperty(process, "platform", { value: platform }));

const child = (pid: number) => ({ pid, exitCode: null, signalCode: null, kill: vi.fn() }) as never as import("node:child_process").ChildProcess;

it("takes a Windows CLI's whole tree down before Tomrade exits", () => {
  Object.defineProperty(process, "platform", { value: "win32" });
  const npx = child(4242);
  stopCliNow(npx);
  expect(ran).toEqual([{ command: "taskkill", args: ["/pid", "4242", "/T", "/F"] }]);
  expect(npx.kill).not.toHaveBeenCalled();
});

it("signals the CLI itself elsewhere", () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  ran.length = 0;
  const agent = child(7);
  stopCliNow(agent);
  expect(ran).toEqual([]);
  expect(agent.kill).toHaveBeenCalledWith("SIGTERM");
});
