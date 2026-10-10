import { it, expect } from "vitest";
import { Context } from "cordis";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createCodexEngine } from "../src/index.js";
import { Tools } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";
import type { TurnIO, TurnInput } from "@tomradex/agent";

it("uses one process for two turns, attributes counters per turn, and interrupts without killing the session", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-protocol-"));
  const log = path.join(dir, "requests.jsonl");
  const bin = path.join(dir, "codex");
  const fake = path.resolve("packages/engine-codex/tests/fake-app-server.mjs");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o700 });
  const ctx = new Context();
  await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
  const engine = createCodexEngine(ctx);
  const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "hello" }, messages: [], cards: [], brief: null, pending: null,
    options: { command: bin }, env: { TOMRADE_TEST_LOG: log } };
  const deltas: string[] = [];
  const io: TurnIO = { emit() {}, delta: (text) => deltas.push(text), progress() {}, signal: new AbortController().signal,
    tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
    run: { id: "run", threadId: "thread", projectId: "project", author: "ai:codex", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
  try {
    const published: string[] = [];
    const ref = { id: "image", name: "input.png", mime: "image/png", size: 3 };
    io.media = { read: () => ({ ...ref, base64: "YWJj" }), path: () => "unused", publish: data => { published.push(data.base64); return ref; } };
    input.input = { kind: "text", text: "hello", attachments: [ref] };
    const one = await engine.turn(input, io);
    expect(one.stop).toBe("end");
    expect(published).toEqual(["YWJj"]);
    input.input = { kind: "text", text: "hello" };
    io.resume = one.resume;
    const two = await engine.turn(input, io);
    expect(two.metrics?.runtime).toBe("warm");
    expect(two.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
    expect(two.metrics?.cacheReadTokens).toBe(7);
    expect(two.metrics?.cacheWriteTokens).toBe(1);
    expect(deltas).toEqual(["hello", "hello"]);
    const abort = new AbortController(); io.signal = abort.signal;
    input.input = { kind: "text", text: "WAIT_FOREVER" };
    const waiting = engine.turn(input, io);
    await new Promise((resolve) => setTimeout(resolve, 100));
    abort.abort();
    expect((await waiting).stop).toBe("cancelled");
    io.signal = new AbortController().signal; input.input = { kind: "text", text: "again" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(requests.find(r => r.method === "turn/start").params.input).toContainEqual({ type: "image", url: "data:image/png;base64,YWJj" });
    expect(requests.filter((r) => r.spawn)).toHaveLength(1);
    expect(requests.filter((r) => r.method === "thread/start")).toHaveLength(1);
    expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(4);
    expect(requests.some((r) => r.method === "turn/interrupt")).toBe(true);
    input.purpose = "code";
    input.input = { kind: "text", text: "REQUEST_PERMISSION" };
    for (const choice of ["Allow once", "Deny", null]) {
      io.requestPermission = async (text) => { expect(text).toContain("npm test"); return choice; };
      const result = await engine.turn(input, io);
      expect(result.stop, result.error).toBe("end");
      io.resume = result.resume;
    }
    const all = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(all.filter((r) => r.id === "permission-request").map((r) => r.result.decision)).toEqual(["accept", "decline", "decline"]);
    const resumed = all.find((r) => r.method === "thread/resume");
    expect(resumed.params.approvalPolicy).toBe("on-request");
    expect(resumed.params.sandbox).toBe("workspace-write");
    expect(resumed.params.approvalsReviewer).toBe("user");
    input.permissionMode = "full-access";
    input.input = { kind: "text", text: "again" };
    expect((await engine.turn(input, io)).stop).toBe("end");
    const changed = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
    expect(changed.filter((r) => r.method === "thread/resume").at(-1).params).toMatchObject({ approvalPolicy: "never", sandbox: "danger-full-access" });
  } finally { await ctx.fiber.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
