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
});
