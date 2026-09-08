import { describe, expect, it } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fresh, settle } from "@tomrade/testkit";
import { Tools, defineTool } from "@tomrade/tools";
import { Mcp } from "@tomrade/mcp";

describe("the MCP surface", () => {
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
      }
    });
    const bound = new Client({ name: "t2", version: "0" });
    await bound.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { "X-Tomrade-Run": "tok-1" } } }));
    const result = await bound.callTool({ name: "echo_tool", arguments: { v: "hi" } });
    expect(JSON.stringify(result.content)).toContain("routed");
    expect(seen).toEqual([{ name: "echo_tool", args: { v: "hi" } }]);
    await bound.close();
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
});
