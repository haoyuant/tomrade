import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
  it("refuses a misspelt parameter with the name it meant, instead of dropping it, and lists the schema as closed", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    const seen: unknown[] = [];
    ctx.tools.register(defineTool({ name: "find", title: "Find", description: "test", input: z.object({ search: z.string().optional(), patch: z.object({ blocks: z.array(z.string()) }).optional() }), execute: (args) => (seen.push(args), "ok") }));
    const client = new Client({ name: "plain", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      const listed = (await client.listTools()).tools.find((t) => t.name === "find")!;
      expect(listed.inputSchema).toMatchObject({ additionalProperties: false, properties: { patch: { additionalProperties: false } } });
      const wrong = await client.callTool({ name: "find", arguments: { query: "dark" } });
      expect(wrong.isError).toBe(true);
      expect(JSON.stringify(wrong.content)).toMatch(/unknown parameter \\"query\\" \(did you mean \\"search\\"\?\)/);
      expect((await client.callTool({ name: "find", arguments: { patch: { blockedBy: [] } } })).isError).toBe(true);
      expect(JSON.stringify(await client.callTool({ name: "find", arguments: { search: "dark" } }))).toContain("ok");
      expect(seen).toEqual([{ search: "dark" }]);
    } finally { await client.close(); await ctx.fiber.dispose(); }
  });
  it("hands every outside client's connection to the tools, the same for all its calls, and says when it closes", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    const seen: (string | undefined)[] = [];
    const closed: string[] = [];
    ctx.on("mcp/closed", (connection) => void closed.push(connection));
    ctx.tools.register(defineTool({ name: "who", title: "Who", description: "test", input: z.object({}), execute: (_args, inv) => (seen.push(inv.connection), "ok") }));
    const a = new Client({ name: "a", version: "0" });
    const b = new Client({ name: "b", version: "0" });
    const ta = new StreamableHTTPClientTransport(new URL(ctx.mcp.url!));
    try {
      await a.connect(ta);
      await b.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      await a.callTool({ name: "who", arguments: {} });
      await b.callTool({ name: "who", arguments: {} });
      await a.callTool({ name: "who", arguments: {} });
      expect(seen[0]).toBe(ta.sessionId);
      expect(seen[2]).toBe(seen[0]);
      expect(seen[1]).toBeTruthy();
      expect(seen[1]).not.toBe(seen[0]);
      await ta.terminateSession();
      expect(closed).toEqual([seen[0]]);
    } finally { await a.close(); await b.close(); await ctx.fiber.dispose(); }
  });
  it("hands a tool the folders a client declares as its roots, and nothing when it declares none", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    ctx.tools.register(defineTool({ name: "where", title: "Where", description: "test", input: z.object({}), execute: async (_args, inv) => ({ roots: inv.roots ? await inv.roots() : null }) }));
    const rooted = new Client({ name: "rooted", version: "0" }, { capabilities: { roots: {} } });
    rooted.setRequestHandler(ListRootsRequestSchema, () => ({ roots: [{ uri: "file:///tmp/work%20tree", name: "work" }] }));
    const plain = new Client({ name: "plain", version: "0" });
    const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);
    try {
      await rooted.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      await plain.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      expect(text(await rooted.callTool({ name: "where", arguments: {} }))).toEqual({ roots: ["/tmp/work tree"] });
      expect(text(await plain.callTool({ name: "where", arguments: {} }))).toEqual({ roots: null });
    } finally { await rooted.close(); await plain.close(); await ctx.fiber.dispose(); }
  });

  it("logs a slow tool call by name and time, never its arguments", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0, slowCallMs: 0 }]] });
    await settle();
    ctx.tools.register(defineTool({ name: "slowish", title: "Slow", description: "test", input: z.object({ secret: z.string() }), execute: () => "ok" }));
    const warnings: string[] = [];
    const spy = vi.spyOn(ctx.mcp.ctx.logger, "warn").mockImplementation((...args: unknown[]) => void warnings.push(args.map(String).join(" ")));
    const client = new Client({ name: "plain", version: "0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
      await client.callTool({ name: "slowish", arguments: { secret: "do-not-log" } });
      expect(warnings.some((w) => /^MCP tool slowish took \d+ms$/.test(w))).toBe(true);
      expect(warnings.join("\n")).not.toContain("do-not-log");
    } finally { spy.mockRestore(); await client.close(); await ctx.fiber.dispose(); }
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
      event: (payload) => ({ additionalContext: `heard ${(payload as { event: string; herdr_pane?: string }).event} in ${(payload as { herdr_pane?: string }).herdr_pane ?? "no pane"}` })
    });
    const bound = new Client({ name: "t2", version: "0" });
    await bound.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { "X-Tomrade-Run": "tok-1" } } }));
    const result = await bound.callTool({ name: "echo_tool", arguments: { v: "hi" } });
    expect(JSON.stringify(result.content)).toContain("routed");
    expect(seen).toEqual([{ name: "echo_tool", args: { v: "hi" } }]);
    const event = await fetch(ctx.mcp.eventUrlFor("tok-1")!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ event: "stop" }) });
    expect(await event.json()).toEqual({ additionalContext: "heard stop in no pane" });
    // A hook run in a herdr pane names it in a header; the binding reads it off the payload.
    const paned = await fetch(ctx.mcp.eventUrlFor("tok-1")!, { method: "POST", headers: { "Content-Type": "application/json", "X-Tomrade-Herdr-Pane": "w1:p1" }, body: JSON.stringify({ event: "stop" }) });
    expect(await paned.json()).toEqual({ additionalContext: "heard stop in w1:p1" });
    await bound.close();
  });

  it("reads a token header an outside agent could not fill in as no token", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    ctx.tools.register(defineTool({ name: "echo_tool", title: "Echo", description: "test", input: z.object({ v: z.string() }), execute: async ({ v }) => ({ echoed: v }) }));
    ctx.mcp.bindRun("tok-x", { author: "ai:hermes", execute: async () => ({ routed: true }) });
    for (const header of ["${TOMRADE_MCP_TOKEN}", "none", ""]) {
      const client = new Client({ name: "outside", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!), { requestInit: { headers: { "X-Tomrade-Run": header } } }));
      const result = await client.callTool({ name: "echo_tool", arguments: { v: header || "empty" } });
      expect(JSON.stringify(result.content), header).toContain("echoed");
      await client.close();
    }
    await ctx.fiber.dispose();
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

  it("hands a long list of records over compacted, as the loop reads it, and leaves anything else whole", async () => {
    const { ctx } = await fresh({ plugins: [Tools, [Mcp, { port: 0 }]] });
    await settle();
    const row = (n: number) => ({ key: `TOM-${n}`, title: `Ticket ${n}`, body: "x".repeat(600), parentId: null, evidence: { resources: [] } });
    const results: Record<string, unknown> = {
      short_list: [row(1)],
      long_list: Array.from({ length: 30 }, (_, i) => row(i + 1)),
      long_record: { body: "y".repeat(10_000) },
      long_text: "z".repeat(30_000)
    };
    for (const [name, result] of Object.entries(results))
      ctx.tools.register(defineTool({ name, title: name, description: "test", input: z.object({}), execute: () => result }));
    ctx.tools.register(defineTool({ name: "schema_list", title: "Schema", description: "test", input: z.object({}), whole: true, execute: () => results.long_list }));
    const client = new Client({ name: "l", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ctx.mcp.url!)));
    const texts = async (name: string) => ((await client.callTool({ name, arguments: {} })).content as { text: string }[]).map((c) => c.text);
    try {
      expect(await texts("short_list")).toEqual([JSON.stringify([row(1)])]);
      const [note, json] = await texts("long_list");
      expect(note).toMatch(/^\(all 30 items; /);
      const rows = JSON.parse(json!) as Record<string, unknown>[];
      expect(rows).toHaveLength(30);
      expect(rows[0]).toEqual({ key: "TOM-1", title: "Ticket 1", body: "x".repeat(160) + "…" });
      expect(await texts("long_record")).toEqual([JSON.stringify(results.long_record)]);
      expect(await texts("long_text")).toEqual([results.long_text]);
      // A tool whose result is reference is never shortened.
      expect(await texts("schema_list")).toEqual([JSON.stringify(results.long_list)]);
    } finally {
      await client.close();
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
      // which Tomrade this is comes right after the paragraphs that must lead (the project's rules)
      const intro = /This is Tomrade \(development build\) dev, pid \d+\.[^\n]*\n\n/;
      expect(scoped.getInstructions()).toMatch(/^first\n\nThis is Tomrade/);
      expect(scoped.getInstructions()?.replace(intro, "")).toBe(`first\n\ntickets of ${project.id}\n\nalways`);

      const plain = await open(ctx.mcp.url!);
      expect(text(await plain.getPrompt({ name: "sync" }))).toBe("sync any project");
      expect(plain.getInstructions()?.replace(intro, "")).toBe("first\n\nalways");

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
