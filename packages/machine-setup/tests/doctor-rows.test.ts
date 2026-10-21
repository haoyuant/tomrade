import path from "node:path";
import { Context } from "cordis";
import { expect, it } from "vitest";
import type { Check } from "@tomradex/contracts";
import MachineSetup from "../src/index.js";
import type { MachineHost, RunResult } from "../src/git.js";

function fakeHost(machine: { files?: string[]; runs?: Record<string, RunResult> }): MachineHost {
  const files = new Set(machine.files ?? []);
  return {
    platform: "linux",
    env: { PATH: "/usr/bin" },
    async run(file, args) {
      return machine.runs?.[[file, ...args].join(" ")] ?? { code: null, output: "", error: `spawn ${file} ENOENT` };
    },
    executable: async (file) => files.has(file),
    adoptPath: () => {},
    wait: async () => {}
  };
}

it("registers the npm and git rows with the troubleshooter, reading the same probes as setup", async () => {
  const checks = new Map<string, Check>();
  const ctx = new Context();
  ctx.provide("doctor", {
    check: (check: Check) => {
      checks.set(check.id, check);
      return () => checks.delete(check.id);
    },
    locale: () => "en"
  } as never);
  await ctx.plugin(MachineSetup);
  const run = (id: string) => checks.get(id)!.run({}, new AbortController().signal);

  ctx.machineSetup.host = fakeHost({
    files: [path.join("/usr/bin", "git"), path.join("/usr/bin", "npm")],
    runs: {
      [`${path.join("/usr/bin", "git")} --version`]: { code: 0, output: "git version 2.44.0\n" },
      [`${path.join("/usr/bin", "npm")} --version`]: { code: 0, output: "11.4.2\n" }
    }
  });
  expect([...checks.keys()].sort()).toEqual(["git", "npm"]);
  expect(await run("git")).toMatchObject({ state: "ok", line: "git 2.44.0" });
  expect(await run("npm")).toMatchObject({ state: "ok", line: expect.stringContaining("npm 11.4.2") });

  // A bare machine warns on both rows, in words that say what to do — nothing fails.
  ctx.machineSetup.host = fakeHost({});
  expect(await run("git")).toMatchObject({ state: "warn", line: expect.stringContaining("git-scm.com") });
  expect(await run("npm")).toMatchObject({ state: "warn", line: expect.stringContaining("Node.js") });
});
