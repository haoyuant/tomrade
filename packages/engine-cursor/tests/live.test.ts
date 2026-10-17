import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Agent } from "@tomradex/agent";
import { localCli } from "@tomradex/engine-claude-code";
import { collect, userMessage } from "@tomradex/llm";
import { Mcp } from "@tomradex/mcp";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { CURSOR_HOOK_SCRIPT, cursorHookReader, cursorHookScript, cursorLentModel, withCursorHooks } from "@tomradex/engine-cursor";

/** Opt-in: runs the real, signed-in cursor-agent. TOMRADE_LIVE_CURSOR=1 pnpm test. */
describe.skipIf(!process.env.TOMRADE_LIVE_CURSOR)("live Cursor", () => {
  it("answers a worker call with its usage, and reports a session through .cursor/hooks.json", async () => {
    const settingsPath = path.join(os.tmpdir(), `tomrade-live-cursor-${Date.now()}.json`);
    const { ctx } = await fresh({ plugins: [Tools, [Settings, { path: settingsPath }], Agent, [Mcp, { port: 0 }]] });
    await settle();
    const heard: unknown[] = [];
    ctx.mcp.onEvent((payload) => heard.push(payload));
    try {
      const lent = cursorLentModel(ctx, { cli: localCli("cursor-agent"), found: async () => true, options: () => ({}) });
      const answer = await collect(lent.model.chat({ system: "Reply with one word.", messages: [userMessage("Say pong.")] }));
      expect(answer.text.toLowerCase()).toContain("pong");
      expect(answer.usage.inputTokens).toBeGreaterThan(0);
      console.log("live cursor worker usage", JSON.stringify(answer.usage));

      // The command code link commits for Cursor.
      const command = `curl -s -m 2 -X POST -H 'Content-Type: application/json' -H 'X-Tomrade-Agent: cursor' --data-binary @- '${ctx.mcp.eventUrl}' >/dev/null 2>&1 || true`;
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-live-cursor-repo-"));
      fs.mkdirSync(path.join(repo, ".cursor"));
      fs.writeFileSync(path.join(repo, ".cursor", "hooks.json"), withCursorHooks(""));
      fs.mkdirSync(path.dirname(path.join(repo, CURSOR_HOOK_SCRIPT)));
      fs.writeFileSync(path.join(repo, CURSOR_HOOK_SCRIPT), cursorHookScript(command), { mode: 0o755 });
      fs.writeFileSync(path.join(repo, "note.txt"), "hello\n");
      // Not execFileSync: the hooks post to this process's own server, which must keep answering.
      await promisify(execFile)("cursor-agent", ["-p", "--output-format", "json", "--trust", "Read note.txt and reply with its one word."], { cwd: repo, encoding: "utf8", timeout: 180_000 });
      await new Promise((r) => setTimeout(r, 1000));
      const read = cursorHookReader();
      const events = heard.map(read).filter((e): e is Record<string, unknown> => !!e);
      expect(events.map((e) => e.hook_event_name)).toEqual(expect.arrayContaining(["SessionStart", "PreToolUse", "PostToolUse", "SessionEnd"]));
      expect(events.every((e) => e.tomrade_agent === "cursor" && fs.realpathSync(e.cwd as string) === fs.realpathSync(repo))).toBe(true);
    } finally {
      await ctx.fiber.dispose();
    }
  }, 600_000);
});
