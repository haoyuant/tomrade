import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fakeProgram } from "../src/fake-program.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-program-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const run = (file: string, args: string[], opts: { timeout?: number; input?: string } = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean; ms: number }>((resolve) => {
    const started = Date.now();
    const child = execFile(file, args, { encoding: "utf8", timeout: opts.timeout }, (error, stdout, stderr) => {
      const e = error as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout, stderr, killed: !!e?.killed, ms: Date.now() - started });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

describe("a fake program", () => {
  it("takes its arguments as given, and hands back what it printed and its exit code", async () => {
    const echo = fakeProgram(path.join(dir, "echo-args"), `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done\necho oops >&2\nexit 3\n`);
    const args = ["a b", 'say "hi"', "C:\\x y\\", "", "tail\\"];
    expect(await run(echo, args)).toMatchObject({ code: 3, stdout: args.map((a) => `[${a}]`).join(""), stderr: "oops\n" });
  });

  it("reads what it is given on its input", async () => {
    const cat = fakeProgram(path.join(dir, "cat"), "#!/bin/sh\ncat\n");
    expect((await run(cat, [], { input: "line one\nline two\n" })).stdout).toBe("line one\nline two\n");
  });

  it("ends with its script when the caller kills it", async () => {
    // exec: elsewhere a killed sh leaves its sleep holding the output open, which is the script's doing, not the fake's.
    const slow = fakeProgram(path.join(dir, "slow"), "#!/bin/sh\nexec sleep 30\n");
    const r = await run(slow, [], { timeout: 300 });
    expect(r.killed).toBe(true);
    expect(r.ms).toBeLessThan(10_000);
  });

  it("runs a script for node with the node running the tests", async () => {
    const node = fakeProgram(path.join(dir, "node-fake"), "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
    expect((await run(node, ["x y", "z"])).stdout).toBe('["x y","z"]');
  });

  it("runs the script written last", async () => {
    const file = path.join(dir, "changing");
    const fake = fakeProgram(file, "#!/bin/sh\necho one\n");
    expect((await run(fake, [])).stdout).toBe("one\n");
    expect(fakeProgram(file, "#!/bin/sh\necho two\n")).toBe(fake);
    expect((await run(fake, [])).stdout).toBe("two\n");
  });

  it("is found by its bare name in a folder put first on PATH", async () => {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fakeProgram(path.join(bin, "tomrade-fake-tool"), "#!/bin/sh\necho found\n");
    const r = await new Promise<string>((resolve) =>
      execFile("tomrade-fake-tool", [], { encoding: "utf8", env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } }, (_e, stdout) => resolve(stdout))
    );
    expect(r).toBe("found\n");
  });
});
