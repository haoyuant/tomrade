import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { expect, it } from "vitest";
import { localCli } from "@tomradex/engine-kit";
import { collect, userMessage } from "@tomradex/llm";
import { piLentModel } from "@tomradex/engine-pi";

function setup(options: { model?: string; effort?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-pi-lent-"));
  const log = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "pi");
  fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${path.resolve("packages/engine-pi/tests/fake-pi-lent.mjs")}' "$@"\n`, { mode: 0o700 });
  const agent = { settingsOf: () => ({ engines: { pi: { command: bin, ...options } } }) };
  const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
  const lent = piLentModel(ctx, { cli: localCli("pi"), found: async () => true });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { lent, log, calls, ask: (user: string) => collect(lent.model.chat({ system: "Reply in JSON.", messages: [userMessage(user)] })) };
}

it("asks pi bare: no session, extensions, tools, MCP, skills, templates, context files or project files", async () => {
  const { lent, ask } = setup({ model: "anthropic/claude-haiku-4-5", effort: "low" });
  expect(lent).toMatchObject({ id: "pi", title: "Pi", rank: 50 });
  const out = await ask("plan it");
  const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; cwd: string; env: Record<string, string | null> };
  expect(echoed.args.slice(0, 15)).toEqual(["-p", "--mode", "json", "--no-session", "-ne", "-nt", "--no-mcp", "-ns", "-np", "-nc", "--no-themes", "-na", "--offline", "--system-prompt", expect.stringMatching(/tomrade-pi-lent-.*system\.md$/)]);
  expect(echoed.args.slice(15)).toEqual(["--model", "anthropic/claude-haiku-4-5", "--thinking", "low"]);
  expect(echoed.system).toBe("Reply in JSON.");
  expect(echoed.prompt).toBe("plan it");
  // Not a Tomrade session: the person's own extension is not loaded anyway, and no token is handed out.
  expect(echoed.env.TOMRADE_MCP_TOKEN).toBeNull();
  expect(out.usage).toEqual({ inputTokens: 57, cacheReadTokens: 40, outputTokens: 3 });
  // the empty folder it ran in goes with the call
  expect(fs.existsSync(echoed.cwd)).toBe(false);

  await expect(ask("FAIL")).rejects.toThrow(/Pi could not answer: 400 model not found/);
}, 30_000);

it("is not ready while pi has no credentials, and says how to sign in", async () => {
  const { lent, log, calls, ask } = setup();
  fs.writeFileSync(log + ".signed-out", "");
  expect(await lent.ready()).toBe(false);
  expect(calls()).toHaveLength(1);
  await expect(ask("plan it")).rejects.toThrow(/Pi has no model it can use \(No API key found for the selected model\.\) — run `pi` and \/login/);
}, 30_000);
