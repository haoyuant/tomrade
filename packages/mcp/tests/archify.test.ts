import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fresh, settle } from "@tomrade/testkit";
import { Tools } from "@tomrade/tools";
import { Settings } from "@tomrade/settings";
import { Agent } from "@tomrade/agent";
import { FakeChatModel, fakeChat } from "@tomrade/llm";
import loop from "@tomrade/engine-loop";
import archify, { ArchifyRuntime } from "@tomrade/archify";
import { Mcp } from "@tomrade/mcp";
import { Files } from "@tomrade/files";
import { Storage } from "@tomrade/storage";
import type { RunHandle } from "@tomrade/tools";

const runHandle = (id: string, projectId: string): RunHandle => ({
  id, threadId: "t1", projectId, author: "ai:test",
  ledger: { all: () => [], find: () => undefined }, waivers: new Set(), scratch: new Map()
});

describe.runIf(!!process.env.ARCHIFY_TEST_SKILL)("Archify shared capability", () => {
  it("delivers from loop and run-bound local MCP, retains editable source, and unloads cleanly", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-archify-flow-"));
    const skill = process.env.ARCHIFY_TEST_SKILL!;
    const install = vi.spyOn(ArchifyRuntime.prototype, "ensureInstalled").mockResolvedValue(skill);
    const spec = JSON.parse(fs.readFileSync(path.join(skill, "examples/web-app.architecture.json"), "utf8"));
    const model = new FakeChatModel([
      { toolCalls: [{ name: "open_playbook", args: { id: "diagram.archify" } }] },
      { toolCalls: [{ name: "diagram_schema", args: { type: "architecture", resource: "schema" } }] },
      { toolCalls: [{ name: "diagram_render", args: { type: "architecture", spec, title: "System" } }] },
      { text: "The system diagram is displayed." }
    ]);
    const { ctx, project } = await fresh({ hubDir: path.join(root, "hub"), plugins: [Tools, [Settings, { path: path.join(root, "settings.json") }], [Storage, { watch: false, reconcileMs: 0 }], fakeChat(model), [Agent, { mediaDir: path.join(root, "media") }], [Files, { watch: false, autoSyncMs: 0 }], loop, [Mcp, { port: 0 }]] });
    await ctx.storage.ready;
    const fiber = ctx.plugin(archify, { cacheDirectory: root, nodeBinary: process.execPath });
    await settle();
    try {
      const thread = ctx.agent.newThread(project.id, "loop");
      const run = ctx.agent.send(project.id, thread.id, { kind: "text", text: "Draw this system" });
      await expect.poll(() => ctx.agent.store.run(project.id, run.runId)?.status).toBe("done");
      const diagram = ctx.agent.thread(project.id, thread.id).messages.find(m => m.block.type === "media")!;
      expect(diagram?.block.type).toBe("media");
      if (diagram.block.type === "media") {
        expect(ctx.agent.readMedia(project.id, thread.id, diagram.block.media.id).mime).toBe("text/html");
        expect(JSON.parse(Buffer.from(ctx.agent.readMedia(project.id, thread.id, diagram.block.media.source!.id).base64, "base64").toString())).toEqual(spec);
      }
      const htmlId = diagram.block.type === "media" ? diagram.block.media.id : "";
      const sourceId = diagram.block.type === "media" ? diagram.block.media.source?.id ?? "" : "";
      const exported = await ctx.tools.execute("diagram_export", { htmlMediaId: htmlId, sourceMediaId: sourceId, directory: "diagrams/system" }, { by: "ai:test", projectId: project.id, run: { ...runHandle(run.runId, project.id), threadId: thread.id } });
      expect(exported).toMatchObject({ ok: true, directory: "diagrams/system", html: { path: "diagrams/system/diagram.html" }, source: { path: "diagrams/system/diagram.json" } });
      expect((await ctx.files.read(project.id, "diagrams/system/diagram.html"))?.size).toBeGreaterThan(1000);
      expect(JSON.parse((await ctx.files.read(project.id, "diagrams/system/diagram.json"))!.body)).toEqual(spec);
      // A complete schema reaches the model, not a clipped tool-result prefix.
      expect(JSON.stringify(model.requests[2].messages)).not.toContain("truncated");
      ctx.agent.engine({
        id: "mcp-local", title: "MCP local agent", author: "ai:codex", available: async () => ({ ok: true }),
        async turn(_input, io) {
          const unbind = ctx.mcp.bindRun("archify-local", { author: io.run.author, projectId: io.run.projectId, execute: (name, args) => io.tools.execute(name, args) });
          const client = new Client({ name: "local-agent", version: "1" });
          try {
            await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!), { requestInit: { headers: { "X-Tomrade-Run": "archify-local" } } }));
            expect((await client.listTools()).tools.map(t => t.name)).toContain("diagram_render");
            const result = await client.callTool({ name: "diagram_render", arguments: { type: "architecture", spec, title: "Local system" } });
            expect(result.isError).not.toBe(true);
            expect(JSON.parse((result.content as { text: string }[])[0].text)).toMatchObject({ ok: true });
            return { stop: "end" };
          } finally { await client.close(); unbind(); }
        }
      });
      const local = ctx.agent.newThread(project.id, "mcp-local");
      const localRun = ctx.agent.send(project.id, local.id, { kind: "text", text: "Draw via MCP" });
      await expect.poll(() => ctx.agent.store.run(project.id, localRun.runId)?.status).not.toBe("running");
      expect(ctx.agent.store.run(project.id, localRun.runId)).toMatchObject({ status: "done", error: null });
      expect(ctx.agent.thread(project.id, local.id).messages.some(m => m.block.type === "media")).toBe(true);
      await fiber.dispose();
      expect(ctx.tools.has("diagram_render")).toBe(false);
      expect(ctx.agent.playbookIndex(project.id).some(p => p.id === "diagram.archify")).toBe(false);
    } finally { await ctx.fiber.dispose(); install.mockRestore(); fs.rmSync(root, { recursive: true, force: true }); }
  });
});
