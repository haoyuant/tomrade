/**
 * Two Tomrades can run on one machine, each with its own data. A client must be
 * able to tell which one it reaches, and whether what it wrote has left it.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Storage } from "@tomradex/storage";
import { Mcp, syncNote } from "@tomradex/mcp";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-mcp-instance-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const QUIET = { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0, autoRestore: false };
const texts = (result: unknown) => ((result as { content: { text: string }[] }).content ?? []).map((c) => c.text);

async function connect(url: string) {
  const client = new Client({ name: "agent", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

describe("which Tomrade answers", () => {
  it("introduces itself, says who it is on /instance and in whoami, and tells a write that has not synced", async () => {
    const hubDir = path.join(root, `hub-${n++}`);
    fs.mkdirSync(hubDir);
    const { ctx, project } = await fresh({ hubDir, plugins: [Tools, [Storage, QUIET], [Mcp, { port: 0, instance: { kind: "packaged", version: "9.9.9", dataDir: "/data/Tomrade" } }]] });
    await settle();
    await ctx.storage.ready;
    const client = await connect(ctx.mcp.urlFor(project.id)!);
    try {
      expect(client.getServerVersion()).toMatchObject({ name: "tomrade", version: "9.9.9" });
      expect(client.getInstructions()).toMatch(/^This is Tomrade \(installed app\) 9\.9\.9, pid \d+, data in \/data\/Tomrade\./);
      const badge = await (await fetch(ctx.mcp.url!.replace(/\/mcp$/, "/instance"))).json();
      expect(badge).toEqual({ app: "tomrade", kind: "packaged", version: "9.9.9", pid: process.pid });

      const created = texts(await client.callTool({ name: "create_item", arguments: { title: "Only here so far", playbookId: null } }));
      expect(created.at(-1)).toBe(`Sync: 1 change is on this Tomrade (packaged 9.9.9) only until it publishes to ${ctx.storage.syncSummary(project.id).location}, within about 30 seconds while it keeps running.`);
      // a read writes nothing and says nothing about sync
      expect(texts(await client.callTool({ name: "list_items", arguments: {} })).join("\n")).not.toContain("Sync:");

      const who = JSON.parse(texts(await client.callTool({ name: "whoami", arguments: {} }))[0]);
      expect(who.instance).toMatchObject({ app: "tomrade", kind: "packaged", version: "9.9.9", dataDir: "/data/Tomrade", mcpUrl: ctx.mcp.url });
      expect(who.project).toMatchObject({ id: project.id, sync: { pending: { count: 1 } } });

      await ctx.storage.publish(project.id);
      const after = JSON.parse(texts(await client.callTool({ name: "whoami", arguments: {} }))[0]);
      expect(after.project.sync.pending.count).toBe(0);
    } finally {
      await client.close();
      await ctx.fiber.dispose();
    }
  });

  it("takes a free port when another Tomrade holds its own, and names the holder", async () => {
    const first = await fresh({ plugins: [Tools, [Mcp, { port: 0, instance: { kind: "packaged", version: "1.2.3" } }]] });
    await settle();
    const port = Number(new URL(first.ctx.mcp.url!).port);
    const second = await fresh({ plugins: [Tools, [Mcp, { port: String(port), instance: { kind: "dev" } }]] });
    await settle();
    try {
      expect(second.ctx.mcp.url).not.toBe(first.ctx.mcp.url);
      expect(second.ctx.mcp.clash).toEqual({ port, heldBy: { app: "tomrade", kind: "packaged", version: "1.2.3", pid: process.pid } });
      const client = await connect(second.ctx.mcp.url!);
      try {
        expect(client.getInstructions()).toContain(`Port ${port} is held by the installed Tomrade 1.2.3 (pid ${process.pid}), which has its own data.`);
        const who = JSON.parse(texts(await client.callTool({ name: "whoami", arguments: {} }))[0]);
        expect(who.instance.portClash).toMatchObject({ port, heldBy: { kind: "packaged" } });
      } finally {
        await client.close();
      }
    } finally {
      await second.ctx.fiber.dispose();
      await first.ctx.fiber.dispose();
    }
  });
});

describe("the sync note", () => {
  const instance = { kind: "dev" as const, version: "dev", dataDir: null };
  it("names why a write stays here when the project cannot publish", () => {
    expect(syncNote({ state: "offline", location: "github.com/acme/app · main", detail: "Cannot reach github.com/acme/app · main", lastSyncAt: null, pending: { count: 2, since: 1 } }, instance)).toBe(
      "Sync: 2 changes are on this Tomrade (dev dev) only — it cannot publish now (Cannot reach github.com/acme/app · main). Other instances and machines will not see them until it does."
    );
    expect(syncNote({ state: "synced", location: "github.com/acme/app · main", lastSyncAt: 1, pending: { count: 0, since: null } }, instance)).toBe("Sync: published to github.com/acme/app · main.");
    expect(syncNote({ state: "local", location: null, lastSyncAt: null, pending: null }, instance)).toBe("Sync: this project is kept on this Tomrade (dev dev) only; it does not sync anywhere.");
  });
});
