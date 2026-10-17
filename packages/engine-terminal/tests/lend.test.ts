import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterEach, beforeEach, expect, it } from "vitest";
import { localCli } from "@tomradex/engine-claude-code";
import { collect, userMessage } from "@tomradex/llm";
import { geminiLentModel, ownModel } from "@tomradex/engine-terminal";

let home = "";
const saved = { GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME, GEMINI_MODEL: process.env.GEMINI_MODEL };
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-home-"));
  process.env.GEMINI_CLI_HOME = home;
  delete process.env.GEMINI_MODEL;
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function setup(engine: { model?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-gemini-lent-"));
  const log = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "gemini");
  fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${path.resolve("packages/engine-terminal/tests/fake-gemini-lent.mjs")}' "$@"\n`, { mode: 0o700 });
  const agent = { settingsOf: () => ({ engines: { gemini: { command: bin, ...engine } } }) };
  const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
  const lent = geminiLentModel(ctx, { cli: localCli("gemini"), found: async () => true });
  return { lent, log, ask: (user: string) => collect(lent.model.chat({ system: "Reply in JSON.", messages: [userMessage(user)] })) };
}

it("asks Gemini CLI bare: its prompt swapped for the call's, no tools, MCP, extensions, skills or hooks", async () => {
  const { lent, ask } = setup();
  expect(lent).toMatchObject({ id: "gemini", title: "Gemini CLI", rank: 40 });
  const out = await ask("plan it");
  const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; env: Record<string, string>; settings: Record<string, unknown> };
  // Flash, not Auto's classifier call and then Pro
  expect(echoed.args).toEqual(["-p", "", "-o", "stream-json", "-e", "none", "--allowed-mcp-server-names", "tomrade-lent-none", "-m", "flash"]);
  expect(echoed.system).toBe("Reply in JSON.");
  expect(echoed.prompt).toBe("plan it");
  expect(echoed.env).toEqual({ NO_BROWSER: "true", GEMINI_CLI_TRUST_WORKSPACE: "true", GEMINI_SANDBOX: "false" });
  expect(echoed.settings).toMatchObject({ tools: { core: [] }, skills: { enabled: false }, hooksConfig: { enabled: false } });
  expect(out.usage).toEqual({ inputTokens: 42, cacheReadTokens: 30, outputTokens: 7 });
  // the lent session is not kept for resuming; the person's own stay
  expect(fs.readdirSync(path.join(home, ".gemini", "tmp", "tomrade-gemini-lent", "chats"))).toEqual(["session-2026-10-01T09-00-0ther111.jsonl"]);

  await expect(ask("FAIL")).rejects.toThrow(/Gemini CLI could not answer: You have exhausted your daily quota/);
}, 30_000);

it("keeps the model the person set, in Tomrade or in Gemini CLI itself", async () => {
  const named = JSON.parse((await setup({ model: "gemini-3.1-pro-preview" }).ask("x")).text) as { args: string[] };
  expect(named.args.slice(-2)).toEqual(["-m", "gemini-3.1-pro-preview"]);
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini", "settings.json"), JSON.stringify({ model: { name: "gemini-3.8-flash" } }));
  expect(ownModel()).toBe("gemini-3.8-flash");
  const own = JSON.parse((await setup().ask("x")).text) as { args: string[] };
  expect(own.args).not.toContain("-m");
  process.env.GEMINI_MODEL = "pro";
  expect(ownModel(path.join(home, "nowhere"))).toBe("pro");
}, 30_000);

it("is not ready while Gemini CLI cannot sign in without a person, and says how to", async () => {
  const { lent, log, ask } = setup();
  fs.writeFileSync(log + ".signed-out", "");
  expect(await lent.ready()).toBe(false);
  await expect(ask("plan it")).rejects.toThrow(/Gemini CLI is not signed in \(Manual authorization is required.*\) — run `gemini`, enter \/auth and choose Use Gemini API Key/);
}, 30_000);

it("takes Google's refusal of a personal sign-in as not signed in, and points at an API key", async () => {
  const { lent, log, ask } = setup();
  fs.writeFileSync(log + ".personal", "");
  await expect(ask("plan it")).rejects.toThrow(/Gemini CLI is not signed in .* Use Gemini API Key .* Settings → Assistant/);
  expect(await lent.ready()).toBe(false);
}, 30_000);
