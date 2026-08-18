import express from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { ConflictError, HumanLockedError, ItemsRepository, NotFoundError } from "@tomrade/core";
import type { ItemKind, ItemStatus } from "@tomrade/core";

export const MCP_SERVER_NAME = "tomrade";
export const MCP_SERVER_VERSION = "0.0.1";

const KIND_ENUM = ["ticket", "epic"] as const;
const STATUS_ENUM = ["backlog", "todo", "doing", "verifying", "done", "cancelled"] as const;

const itemSchema = z.object({
  projectId: z.string().optional(),
  status: z.enum(STATUS_ENUM).optional(),
  kind: z.enum(KIND_ENUM).optional(),
  parentId: z.string().nullable().optional()
});

const createSchema = z.object({
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  kind: z.enum(KIND_ENUM).optional(),
  status: z.enum(STATUS_ENUM).optional(),
  parentId: z.string().nullable().optional(),
  projectId: z.string().optional()
});

const patchSchema = z.object({
  title: z.string().optional(),
  body: z.string().nullable().optional(),
  kind: z.enum(KIND_ENUM).optional(),
  status: z.enum(STATUS_ENUM).optional(),
  parentId: z.string().nullable().optional(),
  rank: z.number().optional()
});

const updateSchema = z.object({
  id: z.string(),
  patch: patchSchema,
  baseVersion: z.number()
});

const idSchema = z.object({ id: z.string() });
const statusSchema = z.object({ id: z.string(), status: z.enum(STATUS_ENUM), baseVersion: z.number() });

/** Wrap a repo call as an MCP tool result: JSON text, or an error result. */
function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(e: unknown) {
  const message =
    e instanceof ConflictError || e instanceof HumanLockedError || e instanceof NotFoundError
      ? e.message
      : e instanceof Error
        ? e.message
        : String(e);
  return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], isError: true };
}

function registerTools(server: McpServer, repo: ItemsRepository): void {
  server.registerTool("tomrade.list_items", {
    title: "List backlog items",
    description: "List Tomrade backlog items, optionally filtered by project, status, kind, or parent.",
    inputSchema: itemSchema
  }, async (args) => {
    try {
      return textResult(repo.list({
        projectId: args.projectId,
        status: args.status as ItemStatus | undefined,
        kind: args.kind as ItemKind | undefined,
        parentId: args.parentId
      }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool("tomrade.get_item", {
    title: "Get one item",
    description: "Fetch a single backlog item by id.",
    inputSchema: idSchema
  }, async (args) => {
    try { return textResult(repo.get(args.id)); } catch (e) { return errorResult(e); }
  });

  server.registerTool("tomrade.create_item", {
    title: "Create item",
    description: "Create a new backlog item (ticket or epic). AI-created; recorded in the oplog and never overwrites human edits.",
    inputSchema: createSchema
  }, async (args) => {
    try {
      return textResult(repo.create({
        title: args.title,
        body: args.body,
        kind: args.kind as ItemKind | undefined,
        status: args.status as ItemStatus | undefined,
        parentId: args.parentId,
        projectId: args.projectId,
        by: "ai:mcp"
      }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool("tomrade.update_item", {
    title: "Update item (optimistic lock)",
    description: "Propose an update to an item. Requires baseVersion = the version you read. Stale versions (ConflictError) and human-locked fields (HumanLockedError) are rejected.",
    inputSchema: updateSchema
  }, async (args) => {
    try {
      return textResult(repo.update(args.id, args.patch, "ai:mcp", { baseVersion: args.baseVersion }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool("tomrade.change_status", {
    title: "Change item status",
    description: "Move an item through the workflow (backlog → todo → doing → verifying → done/cancelled). Requires baseVersion.",
    inputSchema: statusSchema
  }, async (args) => {
    try {
      return textResult(repo.update(args.id, { status: args.status as ItemStatus }, "ai:mcp", { baseVersion: args.baseVersion }));
    } catch (e) { return errorResult(e); }
  });

  server.registerTool("tomrade.delete_item", {
    title: "Delete item",
    description: "Delete an item. Recorded in the oplog; reversible via undo.",
    inputSchema: idSchema
  }, async (args) => {
    try { repo.delete(args.id, "ai:mcp"); return textResult({ ok: true }); } catch (e) { return errorResult(e); }
  });
}

export interface TomradeMcpServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function toSessionId(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw : undefined;
}

/** Session id comes in the Mcp-Session-Id header (spec), with body/query fallbacks. */
function extractSessionId(req: express.Request): string | undefined {
  return toSessionId(req.headers["mcp-session-id"])
    ?? toSessionId((req as { body?: unknown }).body && typeof (req as { body?: { sessionId?: unknown } }).body === "object" ? ((req as { body: { sessionId?: unknown } }).body as { sessionId?: unknown }).sessionId : undefined)
    ?? toSessionId(req.query?.sessionId);
}

/**
 * Start the Tomrade MCP server bound to 127.0.0.1.
 * VS Code agents connect at `http://127.0.0.1:<port>/mcp`.
 */
export async function startTomradeMcpServer(repo: ItemsRepository, port = 19090): Promise<TomradeMcpServer> {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  // createMcpExpressApp() already mounts express.json() and localhost DNS-rebinding protection
  const app = createMcpExpressApp();

  app.post("/mcp", async (req, res) => {
    const sessionId = extractSessionId(req);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res, req.body);
      return;
    }
    // Each client session gets its own McpServer + transport (SDK servers are single-transport).
    const sessionServer = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    registerTools(sessionServer, repo);
    const newTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports.set(sid, newTransport);
      }
    });
    newTransport.onclose = () => {
      for (const [key, value] of transports) {
        if (value === newTransport) transports.delete(key);
      }
      void sessionServer.close();
    };
    await sessionServer.connect(newTransport);
    await newTransport.handleRequest(req, res, req.body);
  });

  app.get("/mcp", async (req, res) => {
    const sessionId = extractSessionId(req);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
      return;
    }
    res.status(400).json({ error: "No active MCP session for the provided session ID" });
  });

  app.delete("/mcp", async (req, res) => {
    const sessionId = extractSessionId(req);
    const transport = sessionId ? transports.get(sessionId) : undefined;
    if (transport) {
      await transport.handleRequest(req, res);
      if (sessionId) transports.delete(sessionId);
      return;
    }
    res.status(400).json({ error: "No active MCP session for the provided session ID" });
  });

  const httpServer = await new Promise<import("node:http").Server>((resolve, reject) => {
    const srv = app.listen(port, "127.0.0.1", () => resolve(srv));
    srv.on("error", reject);
  });
  const actualPort = (httpServer.address() as import("node:net").AddressInfo).port;

  return {
    url: `http://127.0.0.1:${actualPort}/mcp`,
    port: actualPort,
    close: () => new Promise((resolve, reject) => httpServer.close((err) => (err ? reject(err) : resolve())))
  };
}
