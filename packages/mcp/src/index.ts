import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { Context, Service } from "cordis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Author } from "@tomrade/domain";
import type {} from "@tomrade/ipc";
import type {} from "@tomrade/tools";

export const MCP_SERVER_NAME = "tomrade";
export const MCP_SERVER_VERSION = "0.0.1";

declare module "cordis" {
  interface Context {
    mcp: Mcp;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    /** The MCP base url, or the per-project endpoint when a project is named. */
    "mcp.url": (projectId?: string) => string | null;
  }
}

export const McpConfig = z.object({
  host: z.string().default("127.0.0.1"),
  /** 0 picks a free port — what the UI harness uses. */
  port: z.number().int().min(0).max(65535).default(19090)
});
export type McpConfig = z.infer<typeof McpConfig>;

const textResult = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const errorResult = (e: unknown) => ({ content: [{ type: "text" as const, text: `ERROR: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/**
 * An agent run announcing itself: a session opened with the binding's token in
 * `X-Tomrade-Run` executes tools through the run's own gateway, so the ledger,
 * the policies and run-scoped undo see a CLI agent exactly as they see the
 * in-process engine.
 */
export interface RunBinding {
  author: Author;
  projectId?: string;
  execute(name: string, args: unknown): Promise<unknown>;
  /** A lifecycle event posted to `/sessions/<token>/event` — a coding agent's hook reporting it started, stopped, or is waiting. */
  event?(payload: unknown): void;
}

const sessionIdOf = (req: express.Request): string | undefined => {
  const header = req.headers["mcp-session-id"];
  if (typeof header === "string") return header;
  const body = (req as { body?: { sessionId?: unknown } }).body;
  if (body && typeof body === "object" && typeof body.sessionId === "string") return body.sessionId;
  return typeof req.query?.sessionId === "string" ? req.query.sessionId : undefined;
};

/**
 * Every tool in the registry appears here under its own name (the server name
 * is the namespace), executed as ai:mcp through the same guarded path every
 * surface uses — or through a run's gateway when the session presented a run
 * token. Sessions read the registry when they open, so a plugin loaded later
 * is visible to the next one.
 */
export class Mcp extends Service {
  static provide = "mcp";
  static inject = ["tools"];
  static Config = McpConfig;

  url: string | null = null;

  private bindings = new Map<string, RunBinding>();

  constructor(
    ctx: Context,
    public readonly config: McpConfig
  ) {
    super(ctx, "mcp");
  }

  async [Service.init]() {
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const app = createMcpExpressApp();

    // `/mcp/<projectId>` binds every call in the session to one project, so a
    // coding agent in that project's repository needs no projectId argument;
    // bare `/mcp` is for clients that span projects and must name one per call.
    const open = (projectId: string | undefined) => async (req: express.Request, res: express.Response) => {
      const existing = transports.get(sessionIdOf(req) ?? "");
      if (existing) return existing.handleRequest(req, res, req.body);
      const header = req.headers["x-tomrade-run"];
      const bearer = /^Bearer\s+(.+)$/i.exec(typeof req.headers.authorization === "string" ? req.headers.authorization : "")?.[1];
      const token = typeof header === "string" ? header : bearer;
      const server = this.session(token ? this.bindings.get(token) : undefined, projectId);
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport);
        }
      });
      transport.onclose = () => {
        for (const [sid, t] of transports) if (t === transport) transports.delete(sid);
        void server.close();
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    };
    const attached = async (req: express.Request, res: express.Response) => {
      const sid = sessionIdOf(req);
      const transport = transports.get(sid ?? "");
      if (!transport) return res.status(400).json({ error: "No active MCP session for the provided session ID" });
      await transport.handleRequest(req, res);
      if (req.method === "DELETE" && sid) transports.delete(sid);
    };
    app.post("/mcp", open(undefined));
    app.get("/mcp", attached);
    app.delete("/mcp", attached);
    app.post("/mcp/:projectId", (req, res) => open(req.params.projectId)(req, res));
    app.get("/mcp/:projectId", attached);
    app.delete("/mcp/:projectId", attached);
    // A coding agent's hooks (SessionStart, Stop, Notification…) post here with
    // the session's token; the binding that owns the token hears them.
    app.post("/sessions/:token/event", (req, res) => {
      const binding = this.bindings.get(req.params.token);
      if (!binding?.event) return res.status(404).json({ error: "unknown session" });
      try {
        binding.event(req.body);
        res.json({ ok: true });
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    const server = await new Promise<HttpServer>((resolve, reject) => {
      const srv = app.listen(this.config.port, this.config.host, () => resolve(srv));
      srv.on("error", reject);
    });
    const address = server.address();
    // A race with a dying predecessor can yield a bound-then-dropped socket; name the problem instead of a null deref.
    if (!address || typeof address === "string") throw new Error(`MCP could not bind ${this.config.host}:${this.config.port} — is another Tomrade still running?`);
    this.url = `http://${this.config.host}:${(address as AddressInfo).port}/mcp`;
    this.ctx.logger.info(`MCP server ready: ${this.url}`);
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("mcp.url", (projectId) => (projectId ? ctx.mcp.urlFor(projectId) : ctx.mcp.url));
    });

    return () => {
      this.url = null;
      for (const t of transports.values()) void t.close();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    };
  }

  /** The endpoint whose sessions are scoped to one project. The same on every machine, because the id lives in the project's own folder. */
  urlFor(projectId: string): string | null {
    return this.url ? `${this.url}/${encodeURIComponent(projectId)}` : null;
  }

  /** Where a session's hooks post their lifecycle events. */
  eventUrlFor(token: string): string | null {
    return this.url ? `${this.url.replace(/\/mcp$/, "")}/sessions/${encodeURIComponent(token)}/event` : null;
  }

  /** Reversible: the token dies with the run (or the plugin) that registered it. */
  bindRun(token: string, binding: RunBinding): () => void {
    return this.ctx.effect(() => {
      this.bindings.set(token, binding);
      return () => this.bindings.delete(token);
    }, `mcp.bindRun`);
  }

  private session(binding?: RunBinding, projectId?: string): McpServer {
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION });
    for (const tool of this.ctx.tools.list()) {
      server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: tool.input }, async (args) => {
        try {
          if (binding) return textResult(await binding.execute(tool.name, args));
          return textResult(await this.ctx.tools.execute(tool.name, args, { by: "ai:mcp", projectId }));
        } catch (e) {
          return errorResult(e);
        }
      });
    }
    return server;
  }
}

export default Mcp;
