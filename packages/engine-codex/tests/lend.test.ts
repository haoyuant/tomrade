import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Context } from "cordis";
import { expect, it } from "vitest";
import { z } from "zod";
import { collect, completeJson, userMessage } from "@tomradex/llm";
import { codexLentModel } from "@tomradex/engine-codex";

function fakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-codex-lent-"));
  const bin = path.join(dir, "codex");
  fs.writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' '${path.resolve("packages/engine-codex/tests/fake-codex-exec.mjs")}' "$@"\n`, { mode: 0o700 });
  const ctx = new Context();
  ctx.provide("agent", { settingsOf: () => ({ engines: { codex: { command: bin, effort: "low" } } }) } as never);
  return { dir, model: codexLentModel(ctx, async () => true).model };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("asks Codex in a read-only sandbox with the instructions leading the prompt", async () => {
  const { model } = fakeCodex();

  const out = await collect(model.chat({ system: "Reply in JSON.", messages: [userMessage("plan it")] }));
  const echoed = JSON.parse(out.text) as { args: string[]; prompt: string };
  expect(echoed.args.slice(0, 5)).toEqual(["exec", "--json", "--skip-git-repo-check", "-s", "read-only"]);
  expect(echoed.args).toContain('model_reasoning_effort="low"');
  // Codex's coding-agent prompt is swapped for a short one that lives beside the call
  expect(echoed.args.find((arg) => arg.startsWith("model_instructions_file="))).toMatch(/tomrade-codex-lent-.*instructions\.md"$/);
  expect(echoed.prompt).toBe("Reply in JSON.\n\n---\n\nplan it");
  expect(out.usage).toEqual({ inputTokens: 12, outputTokens: 3, cacheReadTokens: 8 });

  await expect(collect(model.chat({ system: "", messages: [userMessage("FAIL")] }))).rejects.toThrow(/not supported when using Codex/);
}, 30_000);

it("ends a Codex that never answers when the call gives up, and stops its process", async () => {
  const { dir, model } = fakeCodex();
  const pidFile = path.join(dir, "pid");
  // The fake notes its pid only once Node is up and has read the prompt; on a busy machine that alone can take seconds.
  await expect(completeJson(model, z.object({}), { system: "", user: `HANG ${pidFile}`, timeoutMs: 10_000 }, "Codex")).rejects.toThrow("Codex did not answer within 10s");
  const pid = Number(fs.readFileSync(pidFile, "utf8"));
  await expect.poll(() => alive(pid), { timeout: 5000 }).toBe(false);
}, 30_000);
