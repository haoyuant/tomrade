import os from "node:os";
import { expect, it } from "vitest";
import { lineSplitter, runJsonl } from "@tomradex/engine-kit";

it("splits records on LF only, across chunk boundaries", () => {
  const lines: string[] = [];
  const push = lineSplitter((line) => lines.push(line));
  const text = JSON.stringify({ a: "x\u2028y" }) + "\r\n" + JSON.stringify({ b: "é" }) + "\n";
  const bytes = Buffer.from(text);
  push(bytes.subarray(0, 5)); push(bytes.subarray(5, bytes.length - 3)); push(bytes.subarray(bytes.length - 3));
  expect(lines.map((line) => JSON.parse(line))).toEqual([{ a: "x\u2028y" }, { b: "é" }]);
});

it("reads a JSON line with U+2028 in a string as one event", async () => {
  const events: Record<string, unknown>[] = [];
  const node = { file: process.execPath, argv: (args: string[]) => ({ command: process.execPath, args }), env: (base = process.env) => base };
  const script = 'process.stdout.write(JSON.stringify({ text: "a\\u2028b\\u2029c" }) + "\\n")';
  const { done } = runJsonl(node, ["-e", script], { cwd: os.tmpdir(), signal: new AbortController().signal, onLine: (event) => events.push(event) });
  expect((await done).code).toBe(0);
  expect(events).toEqual([{ text: "a\u2028b\u2029c" }]);
});
