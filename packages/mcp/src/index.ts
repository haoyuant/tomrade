import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { Context, Service } from "cordis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Author } from "@tomradex/domain";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/tools";
import { LONG_RESULT, compactList, strictInput, type Tools } from "@tomradex/tools";

export const MCP_SERVER_NAME = "tomrade";
export const MCP_SERVER_VERSION = "0.0.1";

declare module "cordis" {
  interface Context {
    mcp: Mcp;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    /** The MCP base url, or the per-project endpoint when a project is named. */
    "mcp.url": (projectId?: string) => string | null;
  }
}

export const McpConfig = z.object({
  host: z.string().default("127.0.0.1"),
  /** 0 picks a free port — what the UI harness uses. */
  port: z.number().int().min(0).max(65535).default(19090),
  /** A tool call this slow is logged, so a hang an agent reports can be found afterwards. */
  slowCallMs: z.number().int().nonnegative().default(10_000)
});
export type McpConfig = z.infer<typeof McpConfig>;

const block = (text: string) => ({ type: "text" as const, text });

/**
 * A tool that already speaks prose is passed through as it is; anything else
 * is compact JSON. Indenting a result costs the model roughly a third more
 * context for nothing it reads. A long list of records comes back as the loop
 * reads it — its note, then rows that are still valid JSON — unless the tool
 * declares its result reference read whole; any other long result stays
 * whole, for the client to size.
 */
function textResult(data: unknown, whole?: boolean) {
  if (typeof data === "string") return { content: [block(data)] };
  const json = JSON.stringify(data);
  const list = !whole && json && json.length > LONG_RESULT ? compactList(data) : null;
  return { content: list ? [block(list.note), block(list.json)] : [block(json)] };
}
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
  /** `signal` aborts when the client cancels the call. */
  execute(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  /** A lifecycle event posted to `/sessions/<token>/event` — a coding agent's hook reporting it started, stopped, or is waiting. */
  event?(payload: unknown): unknown | Promise<unknown>;
}

/** Where a session stands: its project when it opened on `/mcp/<projectId>`, none on the bare endpoint. */
export interface McpScope {
  projectId?: string;
}

/**
 * A prompt the client offers its user as a slash command — Claude Code lists
 * it as `/tomrade:<name>`. Rendered when invoked, so it reads the project as
 * it is then.
 */
export interface McpPrompt {
  name: string;
  title?: string;
  description: string;
  render(scope: McpScope): string;
}

/** One plugin's broken paragraph must not keep a client from connecting. */
const paragraph = (render: (scope: McpScope) => string | null, scope: McpScope): string | null => {
  try {
    return render(scope);
  } catch {
    return null;
  }
};

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
 * token. Sessions read the registry, prompts and instructions when they open,
 * so a plugin loaded later is visible to the next one.
 */
export class Mcp extends Service {
  static provide = "mcp";
  static inject = ["tools"];
  static Config = McpConfig;

  url: string | null = null;

  /** Captured from the injected context: HTTP callbacks run after Cordis's injection frame has closed. */
  private tools: Tools | null = null;
  private bindings = new Map<string, RunBinding>();
  private eventListeners = new Set<(payload: unknown) => void>();
  private prompts = new Map<string, McpPrompt>();
  private instructions = new Map<(scope: McpScope) => string | null, number>();

  constructor(
    ctx: Context,
    public readonly config: McpConfig
  ) {
    super(ctx, "mcp");
  }

  async [Service.init]() {
    this.tools = this.ctx.get("tools") ?? null;
    if (!this.tools) throw new Error("the MCP server needs the tools plugin");
    const transports = new Map<string, StreamableHTTPServerTransport>();
    const app = createMcpExpressApp();

    // `/mcp/<projectId>` binds every call in the session to one project, so a
    // coding agent in that project's repository needs no projectId argument;
    // bare `/mcp` is for clients that span projects and must name one per call.
    const open = (projectId: string | undefined) => async (req: express.Request, res: express.Response) => {
      const sid = sessionIdOf(req);
      const existing = transports.get(sid ?? "");
      if (existing) return existing.handleRequest(req, res, req.body);
      // A session id this server never issued — the client outlived a restart.
      // 404 is what tells a Streamable HTTP client to open a new session rather than give up.
      if (sid) return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found — start a new one" }, id: null });
      const header = req.headers["x-tomrade-run"];
      const bearer = /^Bearer\s+(.+)$/i.exec(typeof req.headers.authorization === "string" ? req.headers.authorization : "")?.[1];
      const token = typeof header === "string" ? header : bearer;
      // Keep the identity, not a closure over the first turn's ledger. An idle
      // or revoked runtime must never fall back to the unbound MCP gateway.
      const server = this.session(token, projectId);
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
    // Hooks committed into a repository carry no token: whoever listens sorts
    // them out by the cwd and session id in the payload.
    app.post("/sessions/event", (req, res) => {
      for (const listener of this.eventListeners) {
        try {
          listener(req.body);
        } catch {
          // one listener's failure is not another's
        }
      }
      res.json({ ok: true });
    });
    // A coding agent's hooks (SessionStart, Stop, Notification…) post here with
    // the session's token; the binding that owns the token hears them.
    app.post("/sessions/:token/event", async (req, res) => {
      const binding = this.bindings.get(req.params.token);
      if (!binding?.event) return res.status(404).json({ error: "unknown session" });
      try {
        res.json((await binding.event(req.body)) ?? {});
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

  /** Where hooks with no token post — the ones a repository commits for every developer. */
  get eventUrl(): string | null {
    return this.url ? `${this.url.replace(/\/mcp$/, "")}/sessions/event` : null;
  }

  /** Hear tokenless hook events. Reversible: the listener goes with the plugin that registered it. */
  onEvent(listener: (payload: unknown) => void): () => void {
    return this.ctx.effect(() => {
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    }, "mcp.onEvent");
  }

  /** Offer a prompt to every session opened from now on. Reversible with the plugin that registered it. */
  prompt(prompt: McpPrompt): () => void {
    return this.ctx.effect(() => {
      this.prompts.set(prompt.name, prompt);
      return () => {
        if (this.prompts.get(prompt.name) === prompt) this.prompts.delete(prompt.name);
      };
    }, `mcp.prompt(${prompt.name})`);
  }

  /**
   * Add a paragraph to the instructions a client reads when it connects. Only
   * sessions without a run token get them: a run Tomrade started already has
   * its brief. Lower `order` comes first — Claude Code keeps only the first
   * 2048 characters.
   */
  instruct(render: (scope: McpScope) => string | null, options: { order?: number } = {}): () => void {
    return this.ctx.effect(() => {
      this.instructions.set(render, options.order ?? 0);
      return () => this.instructions.delete(render);
    }, "mcp.instruct");
  }

  /** Reversible: the token dies with the run (or the plugin) that registered it. */
  bindRun(token: string, binding: RunBinding): () => void {
    return this.ctx.effect(() => {
      this.bindings.set(token, binding);
      return () => {
        if (this.bindings.get(token) === binding) this.bindings.delete(token);
      };
    }, `mcp.bindRun`);
  }

  private session(token?: string, projectId?: string): McpServer {
    const scope: McpScope = projectId ? { projectId } : {};
    const ordered = [...this.instructions].sort((a, b) => a[1] - b[1]).map(([render]) => render);
    const instructions = token ? "" : ordered.map((render) => paragraph(render, scope)).filter(Boolean).join("\n\n");
    const server = new McpServer({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, instructions ? { instructions } : undefined);
    const tools = this.tools;
    if (!tools) throw new Error("the MCP server needs the tools plugin");
    for (const tool of tools.served()) {
      const annotations = tool.readOnly ? { readOnlyHint: true } : undefined;
      // Strict, so a misspelt parameter is refused here with a suggestion instead of stripped before the tool sees it.
      server.registerTool(tool.name, { title: tool.title, description: tool.description, inputSchema: strictInput(tool.input), annotations }, async (args, extra) => {
        const started = Date.now();
        try {
          if (token) {
            const binding = this.bindings.get(token);
            if (!binding) throw new Error("No active run for this runtime");
            return textResult(await binding.execute(tool.name, args, extra.signal), tool.whole);
          }
          return textResult(await tools.execute(tool.name, args, { by: "ai:mcp", projectId, signal: extra.signal }), tool.whole);
        } catch (e) {
          return errorResult(e);
        } finally {
          // Only the name and time: arguments can carry a ticket's whole text.
          const ms = Date.now() - started;
          if (ms >= this.config.slowCallMs) this.ctx.logger.warn(`MCP tool ${tool.name} took ${ms}ms`);
        }
      });
    }
    for (const prompt of this.prompts.values()) {
      server.registerPrompt(prompt.name, { title: prompt.title, description: prompt.description }, () => ({
        description: prompt.description,
        messages: [{ role: "user", content: { type: "text", text: prompt.render(scope) } }]
      }));
    }
    return server;
  }
}

export default Mcp;
