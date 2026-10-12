import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { expect, it } from "vitest";
import { collect, userMessage } from "@tomradex/llm";
import { codexLentModel } from "@tomradex/engine-codex";

it("asks Codex in a read-only sandbox with the instructions leading the prompt", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-lent-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-codex/tests/fake-codex-exec.mjs")}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  ctx.provide("agent", { settingsOf: () => ({ engines: { codex: { command: bin, effort: "low" } } }) } as never);
  const { model } = codexLentModel(ctx, async () => true);

  const out = await collect(model.chat({ system: "Reply in JSON.", messages: [userMessage("plan it")] }));
  const echoed = JSON.parse(out.text) as { args: string[]; prompt: string };
  expect(echoed.args.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "-s", "read-only"]);
  expect(echoed.args).toContain('model_reasoning_effort="low"');
  expect(echoed.prompt).toBe("Reply in JSON.\n\n---\n\nplan it");
  expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 3 });

  await expect(collect(model.chat({ system: "", messages: [userMessage("FAIL")] }))).rejects.toThrow(/not supported when using Codex/);
}, 30_000);
