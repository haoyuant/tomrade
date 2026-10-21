import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { Agent, conversationRecap, type Block, type TurnIO, type TurnInput } from "@tomradex/agent";
import type { CliLaunch } from "@tomradex/engine-kit";
import engineCodex, { codexCanRun, createCodexEngine, readCodexAccount } from "@tomradex/engine-codex";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { lostSession } from "../src/account.js";

const FAKE = path.resolve("packages/engine-codex/tests/fake-account-server.mjs");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-account-"));

/** A `codex` that answers --version and `login status` like the real one, and runs the fake app-server in `mode`. */
function fakeCodex(mode: string): string {
  const bin = path.join(dir, `codex-${mode}`);
  fs.writeFileSync(bin, `#!/bin/sh
case "$1" in --version) echo "codex-cli 9.9.9"; exit 0;; login) echo "Not logged in" >&2; exit 1;; esac
FAKE_MODE=${mode} exec '${process.execPath}' '${FAKE}' "$@"
`, { mode: 0o755 });
  return bin;
}

const launchOf = (file: string): CliLaunch => ({ file, argv: (args) => ({ command: file, args }), env: (base = process.env) => base });

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("asking Codex whether it can run", () => {
  it("takes a custom provider's answer that it needs no OpenAI sign-in, and lists the visible models", async () => {
    const account = await readCodexAccount(launchOf(fakeCodex("custom")));
    expect(account).toEqual({ requiresOpenaiAuth: false, signedIn: false, models: [{ value: "m-1", label: "Model One" }] });
    expect(codexCanRun(account)).toBe(true);
  });

  it("still says no for the OpenAI provider without an account, and yes with one", async () => {
    expect(codexCanRun(await readCodexAccount(launchOf(fakeCodex("openai-none"))), {})).toBe(false);
    expect(codexCanRun(await readCodexAccount(launchOf(fakeCodex("openai-signed"))), {})).toBe(true);
    // `codex exec` takes CODEX_API_KEY on its own, so it is not a clear no.
    expect(codexCanRun({ requiresOpenaiAuth: true, signedIn: false, models: [] }, { CODEX_API_KEY: "k" })).toBeNull();
  });

  it("has no answer from a Codex without account/read", async () => {
    expect(await readCodexAccount(launchOf(fakeCodex("old")))).toBeNull();
    expect(codexCanRun(null)).toBeNull();
  });

  it("gives up on a Codex that never answers, and takes down one that ignores SIGTERM", { timeout: 60_000 }, async () => {
    const pidFile = path.join(dir, "stubborn.pid");
    const started = Date.now();
    // The fake ignores SIGTERM only once Node is up: on a busy machine that takes seconds, so the check must wait longer than that.
    expect(await readCodexAccount(launchOf(fakeCodex("stubborn")), { ...process.env, FAKE_PID_FILE: pidFile }, 5000)).toBeNull();
    // It never answers, so returning at all means the check's own timeout ended it; the slack is for a slow spawn.
    expect(Date.now() - started).toBeLessThan(20_000);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(alive(pid)).toBe(true);
    // SIGKILL follows two seconds later, or later still on a busy machine.
    await expect.poll(() => alive(pid), { timeout: 15_000, interval: 100 }).toBe(false);
  });
});

describe("Codex readiness in Tomrade", () => {
  const home = process.env.CODEX_HOME;
  afterEach(() => { if (home === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = home; });

  async function engines(command: string) {
    const settingsPath = path.join(fs.mkdtempSync(path.join(dir, "settings-")), "settings.json");
    fs.writeFileSync(settingsPath, JSON.stringify({ agent: { defaultEngine: "codex", confirmWritesOver: 0, engines: { codex: { command } }, playbookChoices: {} } }));
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineCodex] });
    await settle();
    const codex = async () => (await ctx.agent.engineViews(true)).find((view) => view.id === "codex")!;
    const use = (next: string) => {
      const all = ctx.settings.get() as { agent: { engines: Record<string, unknown> } };
      ctx.settings.set({ ...all, agent: { ...all.agent, engines: { codex: { command: next } } } });
    };
    return { codex, use };
  }

  it("is ready on a custom provider that `codex login status` calls not logged in, with Codex's models to pick", async () => {
    const { codex } = await engines(fakeCodex("custom"));
    const view = await codex();
    expect(view.ok).toBe(true);
    expect(view.picks?.find((pick) => pick.key === "model")?.choices).toEqual([{ value: "m-1", label: "Model One" }]);
  });

  it("asks for sign-in on the OpenAI provider and says which CODEX_HOME it read", async () => {
    process.env.CODEX_HOME = path.join(dir, "home-without-auth");
    const { codex } = await engines(fakeCodex("openai-none"));
    const view = await codex();
    expect(view).toMatchObject({ ok: false, need: "sign-in", configDir: process.env.CODEX_HOME });
  });

  it("falls back to `codex login status` on an older Codex, and never shows one CLI's models for another", async () => {
    const { codex, use } = await engines(fakeCodex("custom"));
    expect((await codex()).picks?.[0].choices).toHaveLength(1);
    use(fakeCodex("old"));
    const view = await codex();
    expect(view).toMatchObject({ ok: false, need: "sign-in" });
    expect(view.picks?.[0].choices).toEqual([]);
  });
});

describe("a Codex session whose record is gone", () => {
  it("recognises the error and recaps the conversation without the message being answered", () => {
    expect(lostSession(new Error("no rollout found for thread id 01a1"))).toBe(true);
    expect(lostSession("Error: thread/resume: thread/resume failed: no rollout found for thread id x (code -32600)")).toBe(true);
    expect(lostSession("rate limited")).toBe(false);
    const message = (role: "user" | "agent" | "system", block: Block, seq: number) => ({ id: String(seq), threadId: "t", seq, role, block, runId: null, at: seq });
    const recap = conversationRecap([
      message("user", { type: "text", text: "set up the kanban" }, 1),
      message("agent", { type: "text", text: "Done: three columns." }, 2),
      message("system", { type: "status", text: "Error: no rollout found" }, 3),
      message("user", { type: "text", text: "fix kanban" }, 4)
    ]);
    expect(recap).toContain("User: set up the kanban");
    expect(recap).toContain("Assistant: Done: three columns.");
    expect(recap).not.toContain("fix kanban");
    expect(recap).not.toContain("Error");
    expect(conversationRecap([message("user", { type: "text", text: "first" }, 1)])).toBe("");
  });

  it("reports the lost session, then leads a new one with the conversation so far and hands back its id", async () => {
    const log = path.join(dir, "lost.jsonl");
    const ctx = new Context();
    await ctx.plugin(Tools); await ctx.plugin(Mcp, { port: 0 });
    const engine = createCodexEngine(ctx);
    const prior = [
      { id: "1", threadId: "thread", seq: 1, role: "user" as const, block: { type: "text" as const, text: "set up the kanban" }, runId: null, at: 1 },
      { id: "2", threadId: "thread", seq: 2, role: "agent" as const, block: { type: "text" as const, text: "Kanban is set up." }, runId: null, at: 2 },
      { id: "3", threadId: "thread", seq: 3, role: "user" as const, block: { type: "text" as const, text: "fix kanban" }, runId: null, at: 3 }
    ];
    const input: TurnInput = { threadId: "thread", projectId: "project", purpose: "backlog", cwd: dir, input: { kind: "text", text: "fix kanban" }, messages: prior, cards: [], brief: null, pending: null,
      options: { command: fakeCodex("custom") }, env: { TOMRADE_TEST_LOG: log, LOST_ROLLOUT: "1" } };
    const io: TurnIO = { emit() {}, delta() {}, progress() {}, signal: new AbortController().signal, resume: "01a13f89-gone", recap: () => conversationRecap(prior),
      tools: { describe: () => [], execute: async () => ({}) }, llm: null, playbooks: { index: () => [], open: () => null }, workflows: { list: () => [] },
      run: { id: "run", threadId: "thread", projectId: "project", author: "ai:codex", ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map() } };
    try {
      expect(await engine.turn(input, io)).toMatchObject({ stop: "error", lostSession: true });
      io.resume = undefined;
      const result = await engine.turn(input, io);
      expect(result).toMatchObject({ stop: "end", resume: "new-session" });
      const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((s) => JSON.parse(s));
      expect(requests.filter((r) => r.method?.startsWith("thread/")).map((r) => r.method)).toEqual(["thread/resume", "thread/start"]);
      const text = requests.find((r) => r.method === "turn/start").params.input[0].text as string;
      expect(text).toContain("began before your current session");
      expect(text).toContain("User: set up the kanban");
      expect(text).toContain("Assistant: Kanban is set up.");
    } finally { await ctx.fiber.dispose(); }
  });
});
