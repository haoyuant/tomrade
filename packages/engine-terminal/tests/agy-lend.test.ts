import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { afterEach, beforeEach, expect, it } from "vitest";
import { localCli } from "@tomradex/engine-claude-code";
import { collect, userMessage } from "@tomradex/llm";
import { agyDir, agyLentModel, agyWorkerDir } from "@tomradex/engine-terminal";

let home = "";
const savedHome = process.env.HOME;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-home-"));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = savedHome;
});

function setup(options: { model?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-agy-lent-"));
  const bin = path.join(dir, "agy");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-terminal/tests/fake-agy-lent.mjs")}' "$@"\n`, { mode: 0o700 });
  const agent = { settingsOf: () => ({ engines: { agy: { command: bin } } }) };
  const ctx = { get: (name: string) => (name === "agent" ? agent : undefined) } as unknown as Context;
  const lent = agyLentModel(ctx, { cli: localCli("agy"), found: async () => true, options: () => options });
  return { lent, ask: (user: string, system = "Reply in JSON.") => collect(lent.model.chat({ system, messages: [userMessage(user)] })) };
}

it("asks agy in print mode from an empty folder, the instructions leading the prompt, and forgets the conversation", async () => {
  const { lent, ask } = setup({ model: "gemini-3.5-flash" });
  expect(lent).toMatchObject({ id: "agy", title: "Antigravity CLI", rank: 75 });
  const out = await ask("plan it");
  const echoed = JSON.parse(out.text) as { args: string[]; event: string; role: string; prompt: string; cwd: string };
  expect(echoed.args).toEqual(["--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands", "--sandbox", "--model", "gemini-3.5-flash"]);
  expect(echoed).toMatchObject({ event: "user", role: "user", prompt: "Reply in JSON.\n\n---\n\nplan it" });
  expect(fs.realpathSync(echoed.cwd)).toBe(fs.realpathSync(agyWorkerDir()));
  expect(out.usage).toEqual({ inputTokens: 11784, outputTokens: 62, cacheReadTokens: 40 });
  // the lent conversation is gone; the person's own stays
  const dir = agyDir(home);
  expect(fs.readdirSync(path.join(dir, "conversations"))).toEqual(["0ther111-0000-4000-8000-000000000000.db"]);
  expect(fs.readdirSync(path.join(dir, "brain"))).toEqual([]);
  expect(fs.readdirSync(path.join(dir, "annotations"))).toEqual([]);
  expect(fs.readdirSync(path.join(dir, "presence"))).toEqual([]);

  const bare = JSON.parse((await setup().ask("x", "")).text) as { args: string[]; prompt: string };
  expect(bare.args).not.toContain("--model");
  expect(bare.prompt).toBe("x");
}, 30_000);

it("says what agy tried when it denied itself a tool and gave no answer", async () => {
  await expect(setup().ask("DENIED")).rejects.toThrow("Antigravity CLI could not answer: it tried to use command, which a lent call may not");
}, 30_000);

it("is not ready while agy is signed out, and says how to sign in", async () => {
  const { lent, ask } = setup();
  await expect(ask("SIGNED_OUT")).rejects.toThrow("Antigravity CLI is not signed in — run `agy` and sign in");
  expect(await lent.ready()).toBe(false);
}, 30_000);
