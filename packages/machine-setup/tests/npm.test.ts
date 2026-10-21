import path from "node:path";
import { expect, it } from "vitest";
import type { MachineHost, RunResult } from "../src/git.js";
import { probeNpm } from "../src/npm.js";

function fakeHost(machine: { platform?: NodeJS.Platform; env?: Record<string, string | undefined>; files?: string[]; runs?: Record<string, RunResult> }): MachineHost & { adopted: string[] } {
  const files = new Set(machine.files ?? []);
  const adopted: string[] = [];
  return {
    platform: machine.platform ?? "linux",
    env: machine.env ?? {},
    adopted,
    async run(file, args) {
      return machine.runs?.[[file, ...args].join(" ")] ?? { code: null, output: "", error: `spawn ${file} ENOENT` };
    },
    executable: async (file) => files.has(file),
    adoptPath: (dir) => void adopted.push(dir),
    wait: async () => {}
  };
}

it("finds npm on PATH and reads its version", async () => {
  const host = fakeHost({
    env: { PATH: "/usr/bin" },
    files: [path.join("/usr/bin", "npm")],
    runs: { [`${path.join("/usr/bin", "npm")} --version`]: { code: 0, output: "11.4.2\n" } }
  });
  expect(await probeNpm(host)).toEqual({ state: "ready", path: path.join("/usr/bin", "npm"), version: "11.4.2" });
  expect(host.adopted).toEqual([]);
});

it("is missing when neither PATH nor the Node folders have it", async () => {
  expect(await probeNpm(fakeHost({ env: { PATH: "/usr/bin" } }))).toEqual({ state: "missing" });
});

it("adopts a Node install folder PATH misses, so installs find npm too", async () => {
  const file = path.join("C:\\Program Files", "nodejs", "npm.cmd");
  const host = fakeHost({
    platform: "win32",
    env: { PATH: "C:\\Windows", ProgramFiles: "C:\\Program Files" },
    files: [file],
    runs: { [`${file} --version`]: { code: 0, output: "11.4.2\n" } }
  });
  expect(await probeNpm(host)).toMatchObject({ state: "ready", version: "11.4.2" });
  expect(host.adopted).toEqual([path.dirname(file)]);
});

it("reports an npm that does not answer, in its own words", async () => {
  const file = path.join("/usr/bin", "npm");
  const host = fakeHost({ env: { PATH: "/usr/bin" }, files: [file], runs: { [`${file} --version`]: { code: 1, output: "node: bad option\n" } } });
  expect(await probeNpm(host)).toMatchObject({ state: "broken", error: "node: bad option" });
});
