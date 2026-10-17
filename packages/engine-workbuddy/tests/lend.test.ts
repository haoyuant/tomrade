import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { expect, it } from "vitest";
import { collect, userMessage } from "@tomradex/llm";
import { codebuddyLentModel, ownModel, workbuddy } from "@tomradex/engine-workbuddy";

function setup(options: { model?: string; effort?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codebuddy-lent-"));
  const log = path.join(dir, "log.jsonl");
  const bin = path.join(dir, "codebuddy");
  fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${path.resolve("packages/engine-workbuddy/tests/fake-codebuddy-lent.mjs")}' "$@"\n`, { mode: 0o700 });
  const agent = { settingsOf: () => ({ engines: { workbuddy: { command: bin } } }) };
  const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
  const lent = codebuddyLentModel(ctx, { cli: workbuddy.cli, found: async () => true, options: () => options, signIn: workbuddy.signIn! });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []);
  return { lent, log, calls, ask: (user: string) => collect(lent.model.chat({ system: "Reply in JSON.", messages: [userMessage(user)] })) };
}

it("asks CodeBuddy bare: no tools, MCP, settings, memory or saved session, the instructions in a file", async () => {
  const { lent, ask } = setup({ model: "deepseek-v4.1-flash", effort: "low" });
  expect(lent).toMatchObject({ id: "workbuddy", title: "WorkBuddy", rank: 20 });
  const out = await ask("plan it");
  const echoed = JSON.parse(out.text) as { args: string[]; prompt: string; system: string; env: Record<string, string> };
  expect(echoed.args.slice(0, 11)).toEqual(["-p", "--output-format", "stream-json", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--system-prompt-file", expect.stringMatching(/tomrade-codebuddy-lent-.*system\.md$/)]);
  expect(echoed.args.slice(11)).toEqual(["--model", "deepseek-v4.1-flash", "--effort", "low"]);
  expect(echoed.system).toBe("Reply in JSON.");
  expect(echoed.prompt).toBe("plan it");
  expect(echoed.env).toMatchObject({ CODEBUDDY_CODE_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1", CODEBUDDY_CODE_DISABLE_SESSION_SUMMARY: "1" });
  expect(out.usage).toEqual({ inputTokens: 52, cacheReadTokens: 40, outputTokens: 3 });
  // the instructions file goes with the call
  expect(fs.existsSync(path.dirname(echoed.args[10]))).toBe(false);

  await expect(ask("FAIL")).rejects.toThrow(/WorkBuddy could not answer: 400 model \[nope\]/);
}, 30_000);

it("is not ready while CodeBuddy says it is signed out, and says how to sign in", async () => {
  const { lent, log, calls, ask } = setup();
  fs.writeFileSync(log + ".signed-out", "");
  expect(await lent.ready()).toBe(false);
  expect(calls()).toHaveLength(1);
  await expect(ask("plan it")).rejects.toThrow(/WorkBuddy is not signed in \(Authentication required.*\) — run `codebuddy` and \/login/);
}, 30_000);

it("uses the model the person last picked in CodeBuddy when Tomrade names none", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codebuddy-home-"));
  expect(ownModel(home)).toBeUndefined();
  fs.mkdirSync(path.join(home, ".codebuddy"));
  fs.writeFileSync(path.join(home, ".codebuddy", "settings.json"), JSON.stringify({ model: "hy3", trustedDirectories: [] }));
  expect(ownModel(home)).toBe("hy3");
});
