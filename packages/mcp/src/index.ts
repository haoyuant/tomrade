import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type express from "express";
import { Context, Service } from "cordis";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Author } from "@tomradex/domain";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/tools";
import { LONG_RESULT, compactList, defineTool, strictInput, type Tools } from "@tomradex/tools";
import { MCP_WORDS, type McpWords } from "./words.js";

export const MCP_SERVER_NAME = "tomrade";

declare module "cordis" {
  interface Context {
    mcp: Mcp;
  }
  interface Events {
    /** An outside client's connection closed: the client went away, or ended its MCP session. */
    "mcp/closed"(connection: string): void;
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
  /** 0 picks a free port — what the UI harness uses. Taken by another program, a free one is used and the clash shown. */
  port: z.coerce.number().int().min(0).max(65535).default(19090),
  /** A tool call this slow is logged, so a hang an agent reports can be found afterwards. */
  slowCallMs: z.number().int().nonnegative().default(10_000),
  /** Which Tomrade this is: two can run on one machine (the installed app and a checkout), each with its own data. */
  instance: z
    .object({
      kind: z.enum(["packaged", "dev"]).default("dev"),
      version: z.string().default("dev"),
      /** The data directory this instance reads and writes. */
      dataDir: z.string().nullable().default(null)
    })
    .prefault({})
});
export type McpConfig = z.infer<typeof McpConfig>;

/** What `GET /instance` answers: enough for another Tomrade to say who holds the port, nothing about its data. */
export interface InstanceBadge {
  app: "tomrade";
  kind: "packaged" | "dev";
  version: string;
  pid: number;
}

/** The port this instance was configured for, when another program held it. */
export interface PortClash {
  port: number;
  /** The Tomrade holding it, when it answered; null for anything else. */
  heldBy: InstanceBadge | null;
}

interface SyncSummaryLike {
  state: string;
  location: string | null;
  detail?: string;
  lastSyncAt: number | null;
  pending: { count: number; since: number | null } | null;
}
interface StorageLike {
  syncSummary(projectId: string): SyncSummaryLike;
  writeMark(projectId: string): number;
}

/** Who holds `port`: a Tomrade that says so, or null. Never waits long — this runs at startup. */
async function askHolder(host: string, port: number): Promise<InstanceBadge | null> {
  try {
    const res = await fetch(`http://${host}:${port}/instance`, { signal: AbortSignal.timeout(1_000) });
    const body = (await res.json()) as Partial<InstanceBadge>;
    return body.app === "tomrade" && (body.kind === "packaged" || body.kind === "dev") ? { app: "tomrade", kind: body.kind, version: String(body.version), pid: Number(body.pid) } : null;
  } catch {
    return null;
  }
}

const listen = (app: express.Express, port: number, host: string) =>
  new Promise<HttpServer>((resolve, reject) => {
    const srv = app.listen(port, host, () => resolve(srv));
    srv.on("error", reject);
  });

/** One line an agent reads after a write: is it still only here, and if so why and for how long. */
export function syncNote(summary: SyncSummaryLike, instance: McpConfig["instance"]): string {
  const here = `this Tomrade (${instance.kind} ${instance.version})`;
  if (summary.state === "local") return `Sync: this project is kept on ${here} only; it does not sync anywhere.`;
  const where = summary.location ?? "its shared folder";
  const count = summary.pending?.count;
  if (count === 0) return `Sync: published to ${where}.`;
  const waiting = count === undefined ? "Changes are" : `${count} change${count === 1 ? " is" : "s are"}`;
  if (summary.state === "offline" || summary.state === "error" || summary.state === "unavailable")
    return `Sync: ${waiting} on ${here} only — it cannot publish now${summary.detail ? ` (${summary.detail})` : ""}. Other instances and machines will not see ${count === 1 ? "it" : "them"} until it does.`;
  return `Sync: ${waiting} on ${here} only until it publishes to ${where}, within about 30 seconds while it keeps running.`;
}

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

/** A hook that ran in a herdr pane names it in a header; the payload carries it on as `herdr_pane`. */
const withPane = (req: express.Request): Record<string, unknown> => {
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const pane = req.get("X-Tomrade-Herdr-Pane")?.trim();
  return pane ? { ...body, herdr_pane: pane } : body;
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
  /** Set when the configured port was taken and this instance listens elsewhere. */
  clash: PortClash | null = null;

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
      const given = typeof header === "string" ? header.trim() : bearer;
      // A user-level entry names `${TOMRADE_MCP_TOKEN}`: outside a Tomrade session it arrives as written,
      // empty, or as "none" (Hermes must have it set) — no token, as from any other outside client.
      const token = given && given !== "none" && !/^\$\{[^}]*\}$/.test(given) ? given : undefined;
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
        if (transport.sessionId) this.ctx.emit("mcp/closed", transport.sessionId);
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
      const agent = req.get("X-Tomrade-Agent");
      const body = withPane(req);
      for (const listener of this.eventListeners) {
        try {
          listener(agent === "codex" || agent === "workbuddy" || agent === "pi" || agent === "hermes" || agent === "opencode" || agent === "cursor" ? { ...body, tomrade_agent: agent } : body);
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
        res.json((await binding.event(withPane(req))) ?? {});
      } catch (e) {
        res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
      }
    });

    app.get("/instance", (_req, res) => {
      res.json(this.badge());
    });

    // A port another process holds shows as EADDRINUSE, or as a server that "listens" with no address.
    const bind = async (port: number): Promise<{ server: HttpServer; port: number } | null> => {
      try {
        const server = await listen(app, port, this.config.host);
        const address = server.address();
        if (address && typeof address !== "string") return { server, port: (address as AddressInfo).port };
        server.close();
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return null;
        throw error;
      }
    };
    let bound = await bind(this.config.port);
    if (!bound && this.config.port !== 0) {
      // Another Tomrade (the installed app beside a checkout) holds it. Failing here would take every
      // engine that waits on MCP down with it; a free port keeps this instance whole, and the clash is shown.
      this.clash = { port: this.config.port, heldBy: await askHolder(this.config.host, this.config.port) };
      bound = await bind(0);
    }
    if (!bound) throw new Error(`MCP could not bind ${this.config.host}:${this.config.port}`);
    const { server } = bound;
    this.url = `http://${this.config.host}:${bound.port}/mcp`;
    if (this.clash) this.ctx.logger.warn(`MCP port ${this.clash.port} is held by ${this.holderText(MCP_WORDS("en"))}; this instance listens on ${this.url}`);
    else this.ctx.logger.info(`MCP server ready: ${this.url}`);
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("mcp.url", (projectId) => (projectId ? ctx.mcp.urlFor(projectId) : ctx.mcp.url));
    });
    this.ctx.inject(["contributions"], (ctx) => {
      ctx.contributions.statusItem({
        id: "mcp-port",
        icon: "i-warn",
        text: () => {
          if (!this.clash || !this.url) return null;
          const w = this.words();
          const port = new URL(this.url).port;
          return w("portClash", { port, clashPort: this.clash.port, holder: this.holderText(w) });
        },
        title: () => this.words()("portClashTitle")
      });
    });
    // After the project's rules, which must lead (a client may keep only the start), before everything else.
    this.instruct(() => this.introduction(), { order: -0.5 });
    this.registerWhoami();

    return () => {
      this.url = null;
      for (const t of transports.values()) void t.close();
      return new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    };
  }

  /** This instance, as `GET /instance` tells another one. */
  badge(): InstanceBadge {
    return { app: "tomrade", kind: this.config.instance.kind, version: this.config.instance.version, pid: process.pid };
  }

  private words(): McpWords {
    return MCP_WORDS((this.ctx.get("settings") as { locale?: () => string } | undefined)?.locale?.());
  }

  /** Who holds the clashed port, in words. */
  holderText(w: McpWords = this.words()): string {
    const held = this.clash?.heldBy;
    if (!held) return w("holderUnknown");
    return w("holder", { kind: w(held.kind === "packaged" ? "holderPackaged" : "holderDev"), version: held.version, pid: held.pid });
  }

  /** The first thing a client reads: which Tomrade, and which data, it is talking to. */
  private introduction(): string {
    const { kind, version, dataDir } = this.config.instance;
    const clash = this.clash ? ` Port ${this.clash.port} is held by ${this.holderText(MCP_WORDS("en"))}, which has its own data.` : "";
    return `This is Tomrade ${kind === "packaged" ? "(installed app)" : "(development build)"} ${version}, pid ${process.pid}${dataDir ? `, data in ${dataDir}` : ""}.${clash} Another Tomrade on this machine keeps separate data; call whoami when unsure which one you reach or whether your writes have synced.`;
  }

  private registerWhoami(): void {
    this.ctx.tools.register(defineTool({
      name: "whoami",
      title: "Which Tomrade is this",
      description:
        "Which Tomrade answers this connection (installed or development build, version, process, data folder, port), the signed-in account, and a project's sync: writes made here not yet shared. Two Tomrades on one machine keep separate data — call it when an item you created seems missing, or before relying on another instance or machine seeing your writes.",
      input: z.object({ projectId: z.string().optional().describe("The project to report sync for; omit for the current one, or for every project when there is none") }),
      readOnly: true,
      execute: ({ projectId }, inv) => {
        const storage = this.ctx.get("storage") as StorageLike | undefined;
        const hub = this.ctx.get("hub") as { catalog: { projects(): { id: string; name: string }[] } } | undefined;
        const cloud = (this.ctx.get("cloudHub") as { info(): { user: { email: string } | null; hubId: string | null } } | undefined)?.info();
        const sync = (id: string) => storage?.syncSummary(id) ?? null;
        const scope = projectId ?? inv.projectId;
        const projects = hub?.catalog.projects() ?? [];
        return {
          instance: { ...this.badge(), dataDir: this.config.instance.dataDir, mcpUrl: this.url, ...(this.clash ? { portClash: this.clash } : {}) },
          account: cloud ? { email: cloud.user?.email ?? null, hubId: cloud.hubId } : null,
          ...(scope
            ? { project: { id: scope, name: projects.find((p) => p.id === scope)?.name ?? null, sync: sync(scope) } }
            : { projects: projects.map((p) => ({ id: p.id, name: p.name, sync: sync(p.id) })) })
        };
      }
    }));
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
    const server = new McpServer({ name: MCP_SERVER_NAME, version: this.config.instance.version }, instructions ? { instructions } : undefined);
    const tools = this.tools;
    if (!tools) throw new Error("the MCP server needs the tools plugin");
    for (const tool of tools.served(token ? "run" : "public")) {
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
          const storage = tool.readOnly ? undefined : (this.ctx.get("storage") as StorageLike | undefined);
          const target = (args as { projectId?: unknown }).projectId;
          const pid = typeof target === "string" ? target : projectId;
          const mark = storage && pid ? storage.writeMark(pid) : null;
          // Asked only when a tool needs it: most calls never touch the client's folders.
          const roots = server.server.getClientCapabilities()?.roots
            ? async () => (await server.server.listRoots(undefined, { signal: extra.signal })).roots.map((r) => fileURLToPath(r.uri))
            : undefined;
          const result = textResult(
            await tools.execute(tool.name, args, { by: "ai:mcp", projectId, signal: extra.signal, ...(extra.sessionId ? { connection: extra.sessionId } : {}), ...(roots ? { roots } : {}) }),
            tool.whole
          );
          // Only after a call that wrote: the agent learns whether the write is still on this instance alone.
          if (storage && pid && mark !== null && storage.writeMark(pid) > mark) result.content.push(block(syncNote(storage.syncSummary(pid), this.config.instance)));
          return result;
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
