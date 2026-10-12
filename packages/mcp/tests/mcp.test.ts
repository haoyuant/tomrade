import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fresh, settle } from "@tomradex/testkit";
import { Tools, defineTool } from "@tomradex/tools";
import { Mcp } from "@tomradex/mcp";

describe("the MCP surface", () => {
  it("rebinds an existing connection to the new run and denies idle or revoked tokens", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    let unscoped = 0;
    ctx.tools.register(defineTool({ name: "touch", title: "Touch", description: "test", input: z.object({}), execute: () => { unscoped++; return "unscoped"; } }));
    const first = ctx.mcp.bindRun("persistent", { author: "ai:codex", execute: async () => "run-1" });
    const client = new Client({ name: "persistent", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!), { requestInit: { headers: { "X-Tomrade-Run": "persistent" } } }));
      const call = () => client.callTool({ name: "touch", arguments: {} });
      expect(JSON.stringify(await call())).toContain("run-1");
      first();
      expect((await call()).isError).toBe(true);
      const second = ctx.mcp.bindRun("persistent", { author: "ai:codex", execute: async () => "run-2" });
      expect(JSON.stringify(await call())).toContain("run-2");
      second();
      expect((await call()).isError).toBe(true);
      expect(unscoped).toBe(0);
    } finally { await client.close(); await ctx.fiber.dispose(); }
  });
  it("never offers a tool kept in this process, with or without a run token", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    let ran = 0;
    ctx.tools.register(defineTool({ name: "open_tool", title: "Open", description: "test", input: z.object({}), execute: () => "ok" }));
    ctx.tools.register(defineTool({ name: "local_tool", title: "Local", description: "test", input: z.object({}), mcp: false, execute: () => { ran++; return "ran"; } }));
    ctx.tools.register(defineTool({ name: "read_tool", title: "Read", description: "test", input: z.object({}), readOnly: true, execute: () => "read" }));
    const unbind = ctx.mcp.bindRun("local-run", { author: "ai:codex", execute: async (name, args) => ctx.tools.execute(name, args, { by: "ai:codex" }) });
    const clients = [new Client({ name: "plain", version: "0" }), new Client({ name: "run", version: "0" })];
    try {
      await clients[0]!.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      await clients[1]!.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!), { requestInit: { headers: { "X-Tomrade-Run": "local-run" } } }));
      for (const client of clients) {
        const listed = (await client.listTools()).tools;
        const names = listed.map((t) => t.name);
        expect(names).toContain("open_tool");
        // Codex runs a read-only tool without asking; every other tool keeps its default.
        expect(listed.find((t) => t.name === "read_tool")?.annotations).toEqual({ readOnlyHint: true });
        expect(listed.find((t) => t.name === "open_tool")?.annotations).toBeUndefined();
        expect(names).not.toContain("local_tool");
        expect((await client.callTool({ name: "local_tool", arguments: {} })).isError).toBe(true);
      }
      expect(ran).toBe(0);
    } finally {
      unbind();
      for (const client of clients) await client.close();
      await ctx.fiber.dispose();
    }
  });
  it("lists tools under their own names and routes a run token to its binding", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    ctx.tools.register(
      defineTool({ name: "echo_tool", title: "Echo", description: "test", input: z.object({ v: z.string() }), execute: ({ v }) => ({ echoed: v }) })
    );
    const url = ctx.mcp.url!;
    expect(url).toBeTruthy();

    const plain = new Client({ name: "t", version: "0" });
    await plain.connect(new StreamableHTTPClientTransport(new URL(url)));
    const tools = await plain.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("echo_tool");
    expect(tools.tools.every((t) => !t.name.startsWith("tomrade."))).toBe(true);
    await plain.close();

    const seen: { name: string; args: unknown }[] = [];
    ctx.mcp.bindRun("tok-1", {
      author: "ai:claude-code",
      execute: async (name, args) => {
        seen.push({ name, args });
        return { routed: true };
      },
      event: (payload) => ({ additionalContext: `heard ${(payload as { event: string }).event}` })
    });
    const bound = new Client({ name: "t2", version: "0" });
    await bound.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { "X-Tomrade-Run": "tok-1" } } }));
    const result = await bound.callTool({ name: "echo_tool", arguments: { v: "hi" } });
    expect(JSON.stringify(result.content)).toContain("routed");
    expect(seen).toEqual([{ name: "echo_tool", args: { v: "hi" } }]);
    const event = await fetch(ctx.mcp.eventUrlFor("tok-1")!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "stop" }) });
    expect(await event.json()).toEqual({ additionalContext: "heard stop" });
    await bound.close();
  });

  it("passes a client's cancellation to the tool, bound or not", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    const aborted: string[] = [];
    ctx.tools.register(
      defineTool({
        name: "slow",
        title: "Slow",
        description: "test",
        input: z.object({}),
        execute: (_args, inv) => new Promise((resolve) => inv.signal?.addEventListener("abort", () => resolve(aborted.push("unbound"))))
      })
    );
    ctx.mcp.bindRun("tok-c", {
      author: "ai:test",
      execute: (_name, _args, signal) => new Promise((resolve) => signal?.addEventListener("abort", () => resolve(aborted.push("bound"))))
    });
    let expected = 0;
    const cancelled = async (headers: Record<string, string>) => {
      expected += 1;
      const client = new Client({ name: "c", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!), { requestInit: { headers } }));
      const abort = new AbortController();
      const call = client.callTool({ name: "slow", arguments: {} }, undefined, { signal: abort.signal });
      setTimeout(() => abort.abort(), 100);
      await call.catch(() => {});
      // The cancellation is a notification sent after the call rejects; closing first would drop it.
      for (const t0 = Date.now(); aborted.length < expected && Date.now() - t0 < 3000; ) await new Promise((r) => setTimeout(r, 10));
      await client.close();
    };
    try {
      await cancelled({});
      await cancelled({ "X-Tomrade-Run": "tok-c" });
      expect(aborted.sort()).toEqual(["bound", "unbound"]);
    } finally {
      await ctx.fiber.dispose();
    }
  });

  it("scopes a /mcp/<projectId> session to that project, and leaves the bare endpoint unscoped", async () => {
    const { ctx, project } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    ctx.tools.register(
      defineTool({ name: "whose_project", title: "Whose", description: "test", input: z.object({}), execute: (_args, inv) => ({ projectId: inv.projectId ?? null }) })
    );
    const scoped = new Client({ name: "s", version: "0" });
    await scoped.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.urlFor(project.id)!)));
    const answer = (result: { content?: unknown }) => JSON.parse((result.content as { text: string }[])[0].text) as { projectId: string | null };
    expect(answer(await scoped.callTool({ name: "whose_project", arguments: {} })).projectId).toBe(project.id);
    await scoped.close();

    const plain = new Client({ name: "p", version: "0" });
    await plain.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
    expect(answer(await plain.callTool({ name: "whose_project", arguments: {} })).projectId).toBeNull();
    await plain.close();
  });
  it("offers registered prompts rendered for the session's project, and instructions only to sessions without a run token", async () => {
    const { ctx, project } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    const drop = ctx.mcp.prompt({ name: "sync", title: "Sync", description: "Sync this session", render: ({ projectId }) => `sync ${projectId ?? "any project"}` });
    ctx.mcp.instruct(({ projectId }) => (projectId ? `tickets of ${projectId}` : null));
    ctx.mcp.instruct(() => "always");
    ctx.mcp.instruct(() => {
      throw new Error("broken plugin");
    });
    ctx.mcp.instruct(() => "first", { order: -1 });
    const unbind = ctx.mcp.bindRun("run-tok", { author: "ai:codex", execute: async () => "x" });
    const text = (result: { messages: { content: unknown }[] }) => (result.messages[0]!.content as { text: string }).text;
    const clients: Client[] = [];
    const open = async (url: string, headers?: Record<string, string>) => {
      const client = new Client({ name: `c${clients.length}`, version: "0" });
      clients.push(client);
      await client.connect(new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined));
      return client;
    };
    try {
      const scoped = await open(ctx.mcp.urlFor(project.id)!);
      expect((await scoped.listPrompts()).prompts.map((p) => p.name)).toEqual(["sync"]);
      expect(text(await scoped.getPrompt({ name: "sync" }))).toBe(`sync ${project.id}`);
      expect(scoped.getInstructions()).toBe(`first\n\ntickets of ${project.id}\n\nalways`);

      const plain = await open(ctx.mcp.url!);
      expect(text(await plain.getPrompt({ name: "sync" }))).toBe("sync any project");
      expect(plain.getInstructions()).toBe("first\n\nalways");

      const run = await open(ctx.mcp.url!, { "X-Tomrade-Run": "run-tok" });
      expect((await run.listPrompts()).prompts.map((p) => p.name)).toEqual(["sync"]);
      expect(run.getInstructions()).toBeUndefined();

      drop();
      const later = await open(ctx.mcp.url!);
      expect(later.getServerCapabilities()?.prompts).toBeUndefined();
    } finally {
      unbind();
      for (const client of clients) await client.close();
      await ctx.fiber.dispose();
    }
  });
});
