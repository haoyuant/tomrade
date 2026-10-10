import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { Agent, type RunView } from "@tomradex/agent";
import engineCodex from "@tomradex/engine-codex";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";

const FAKE = `#!/bin/bash
dir="$(dirname "$0")"
printf '%s\\n' "$@" > "$dir/args.txt"
echo '{"type":"thread.started","thread_id":"codex-session-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"hello from codex"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":4}}'
`;

async function settled(ctx: Context, projectId: string, runId: string): Promise<RunView> {
  for (let n = 0; n < 800; n += 1) {
    const run = ctx.agent.store.run(projectId, runId);
    if (run && run.status !== "running") return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not settle");
}

describe("the Codex engine", () => {
  it("migrates Tomrade's rejected legacy preset and lets the authenticated CLI choose its default", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-codex-"));
    const bin = path.join(dir, "codex.sh");
    fs.writeFileSync(bin, FAKE, { mode: 0o755 });
    const settingsPath = path.join(dir, "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ agent: { defaultEngine: "codex", confirmWritesOver: 0, engines: { codex: { transport: "cli", command: bin, model: "gpt-5-codex" } }, playbookChoices: {} } })
    );

    const { ctx, project } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }], engineCodex] });
    await settle();

    const options = ((ctx.settings.get().agent as { engines: { codex: Record<string, unknown> } }).engines.codex);
    expect(options.model).toBeUndefined();
    const thread = ctx.agent.newThread(project.id, "codex");
    const { runId } = ctx.agent.send(project.id, thread.id, { kind: "text", text: "hello" });
    const run = await settled(ctx, project.id, runId);
    expect(run.status).toBe("done");
    expect(run.usage).toEqual({ inputTokens: 7, outputTokens: 4 });
    expect(ctx.agent.store.messages(project.id, thread.id).some((entry) => entry.block.type === "text" && entry.block.text === "hello from codex")).toBe(true);

    const args = fs.readFileSync(path.join(dir, "args.txt"), "utf8").split("\n");
    expect(args).not.toContain("-m");
    expect(args).toContain('mcp_servers.tomrade.default_tools_approval_mode="approve"');

    const next = ctx.agent.send(project.id, thread.id, { kind: "text", text: "again" });
    expect((await settled(ctx, project.id, next.runId)).status).toBe("done");
    const resumed = fs.readFileSync(path.join(dir, "args.txt"), "utf8").split("\n");
    expect(resumed.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(resumed).not.toContain("-s");
    expect(resumed).not.toContain("-C");
    expect(resumed).toContain('mcp_servers.tomrade.default_tools_approval_mode="approve"');
    expect(resumed.indexOf("--json")).toBeLessThan(resumed.indexOf("codex-session-1"));
  });
});
