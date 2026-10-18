import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type RunView } from "@tomradex/agent";
import engineCodex, { codexInstall, codexSignedIn } from "@tomradex/engine-codex";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

async function settled(ctx: Context, projectId: string, runId: string): Promise<RunView> {
  for (let n = 0; n < 800; n += 1) {
    const run = ctx.agent.store.run(projectId, runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not settle");
}

describe("the Codex engine", () => {
  it("migrates Tomrade's rejected legacy preset, ignores a saved cli transport, and runs through app-server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
    const log = path.join(dir, "requests.jsonl");
    const bin = path.join(dir, "codex");
    const fake = path.resolve("packages/engine-codex/tests/fake-app-server.mjs");
    fs.writeFileSync(bin, `#!/bin/sh\nTOMRADE_TEST_LOG='${log}' exec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o700 });
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ agent: { defaultEngine: "codex", confirmWritesOver: 0, engines: { codex: { transport: "cli", command: bin, model: "gpt-5-codex" } }, playbookChoices: {} } })
    );

    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineCodex] });
    await settle();
    try {
      const options = ((ctx.settings.get().agent as { engines: { codex: Record<string, unknown> } }).engines.codex);
      expect(options.model).toBeUndefined();
      const thread = ctx.agent.newThread(project.id, "codex");
      const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hello" });
      const run = await settled(ctx, project.id, runId);
      expect(run.status, run.error ?? undefined).toBe("done");
      expect(run.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
      expect(ctx.agent.store.messages(project.id, thread.id).some((entry) => entry.block.type === "text" && entry.block.text === "hello")).toBe(true);

      const next = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
      expect((await settled(ctx, project.id, next.runId)).status).toBe("done");

      const requests = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const spawns = requests.filter((r) => r.spawn);
      expect(spawns).toHaveLength(1);
      expect(spawns[0].args[0]).toBe("app-server");
      expect(spawns[0].args).toContain('mcp_servers.tomrade.default_tools_approval_mode="approve"');
      expect(requests.find((r) => r.method === "thread/start").params.model).toBeUndefined();
      expect(requests.filter((r) => r.method === "turn/start")).toHaveLength(2);
    } finally {
      await ctx.fiber.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("whether Codex is signed in", () => {
  it("reads `codex login status`, and does not guess at anything else", () => {
    expect(codexSignedIn("Logged in using ChatGPT\n")).toBe(true);
    expect(codexSignedIn("Logged in using an API key - sk-***\n")).toBe(true);
    expect(codexSignedIn("Not logged in\n")).toBe(false);
    expect(codexSignedIn("error: unrecognized subcommand 'login'")).toBeNull();
  });
});

describe("how Codex installs on this machine", () => {
  it("offers npm only where npm is, Homebrew where it is, and no command without either", () => {
    expect(codexInstall({ npm: true, brew: false })).toEqual(["npm install -g @openai/codex"]);
    expect(codexInstall({ npm: true, brew: true })).toEqual(["npm install -g @openai/codex", "brew install --cask codex"]);
    expect(codexInstall({ npm: false, brew: true })).toEqual(["brew install --cask codex"]);
    expect(codexInstall({ npm: false, brew: false })).toEqual([]);
  });
});
