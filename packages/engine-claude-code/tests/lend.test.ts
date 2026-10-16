import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterEach, describe, expect, it } from "vitest";
import { collect, userMessage } from "@tomradex/llm";
import { claudeLentModel } from "@tomradex/engine-claude-code";

const closers: (() => void)[] = [];
afterEach(() => closers.splice(0).forEach((close) => close()));

function setup(idleMs?: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-lent-"));
  const log = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "claude");
  const fake = path.resolve("packages/engine-claude-code/tests/fake-claude-lent.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
  const agent = { settingsOf: () => ({ engines: { "claude-code": { command: bin } } }) };
  const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
  const lent = claudeLentModel(ctx, async () => true, { idleMs });
  closers.push(lent.close);
  const records = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  const ask = (user: string, signal?: AbortSignal) => collect(lent.model.chat({ system: `SYS ${user}`, messages: [userMessage(user)] }, signal));
  return { lent, records, spawns: () => records().filter((r) => r.spawn), ask };
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function until(check: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("Claude Code lent to the worker role", () => {
  it("keeps one session between calls, clears it after each, and carries the call's instructions", async () => {
    const { ask, spawns, records } = setup();
    expect((await ask("one")).text).toBe('{"seen":1}');
    const second = await ask("two");
    expect(second.text).toBe('{"seen":1}');
    expect(second.usage).toEqual({ inputTokens: 9005, outputTokens: 2, cacheReadTokens: 9000, cacheWriteTokens: 0 });
    expect(spawns()).toHaveLength(1);
    const args = spawns()[0].args.join("\n");
    expect(args).toContain("--strict-mcp-config");
    expect(args).not.toContain("--max-turns");
    const sent = records().filter((r) => r.content).map((r) => r.content);
    expect(sent[0]).toMatch(/^<instructions>\nSYS one\n<\/instructions>\n\none$/);
    expect(sent[1]).toBe("/clear");
  });

  it("answers a call that arrives while the session is busy in a process of its own", async () => {
    const { ask, spawns } = setup();
    const [a, b] = await Promise.all([ask("SLOW a"), ask("b")]);
    expect([a.text, b.text]).toEqual(['{"seen":1}', '{"seen":1}']);
    expect(spawns()).toHaveLength(2);
    // both start at once, so either may log first
    expect(spawns().filter((r) => r.args.join("\n").includes("--max-turns\n1"))).toHaveLength(1);
  });

  it("retries once in a fresh process when the kept one dies before answering", async () => {
    const { ask, spawns } = setup();
    expect((await ask("CRASH_ONCE")).text).toBe('{"seen":1}');
    expect(spawns()).toHaveLength(2);
    expect((await ask("after")).text).toBe('{"seen":1}');
    expect(spawns()).toHaveLength(3);
  });

  it("ends the process of a call that is withdrawn mid-answer", async () => {
    const { ask, spawns } = setup();
    const stop = new AbortController();
    const pending = ask("WAIT_FOREVER", stop.signal);
    await until(() => spawns().length === 1);
    const pid = spawns()[0].spawn;
    await new Promise((r) => setTimeout(r, 200));
    stop.abort();
    await expect(pending).rejects.toThrow();
    await until(() => !alive(pid));
    expect((await ask("next")).text).toBe('{"seen":1}');
    expect(spawns()).toHaveLength(2);
  });

  it("lets an idle session exit, and close() ends a kept one", async () => {
    const idle = setup(150);
    await idle.ask("one");
    const pid = idle.spawns()[0].spawn;
    await until(() => !alive(pid));

    const closing = setup();
    await closing.ask("one");
    const kept = closing.spawns()[0].spawn;
    await new Promise((r) => setTimeout(r, 100));
    expect(alive(kept)).toBe(true);
    closing.lent.close();
    await until(() => !alive(kept));
  });
});
