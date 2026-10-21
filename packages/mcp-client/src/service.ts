import { Context, Service } from "cordis";
import { z } from "zod";
import { defineTool } from "@tomradex/tools";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/settings";
import { MCP_SERVERS_SECTION, McpClientSettings, McpServerConfig, targetOf, toolName } from "./config.js";
import { Connection, type RemoteTool, type ServerInfo } from "./connection.js";
import { parseClientConfig } from "./import.js";
import { inputSchemaOf } from "./schema.js";
import { errorMessage } from "@tomradex/contracts";

export const McpClientConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** The wait before each automatic reconnect; once they run out, a server stays failed until reconnected by hand. */
    retryDelaysMs: z.array(z.number().int().min(0)).default([1_000, 5_000, 30_000]),
    /** A connection that lasted this long before it dropped earns a fresh set of retries; a server that keeps dying sooner runs out. */
    stableMs: z.number().int().min(0).default(60_000)
  })
);
export type McpClientConfig = z.output<typeof McpClientConfig>;

export type McpServerState = "off" | "connecting" | "connected" | "failed";

export interface McpToolView {
  /** The name agents call it by. */
  name: string;
  /** The name the server gave it. */
  remote: string;
  title?: string;
  description?: string;
  /** Why it is not registered, when it is not. */
  skipped?: string;
  /** The schema could not be read exactly; the tool takes any arguments and the model is shown the original. */
  approximate?: boolean;
}

export interface McpServerView {
  id: string;
  enabled: boolean;
  transport: "stdio" | "http";
  target: string;
  state: McpServerState;
  error?: string;
  server?: ServerInfo;
  tools: McpToolView[];
  /** An automatic reconnect is scheduled or under way: which attempt, of how many. */
  retry?: { attempt: number; of: number };
}

export type McpTestResult = { ok: true; server?: ServerInfo; tools: string[] } | { ok: false; error: string };

declare module "cordis" {
  interface Context {
    mcpClient: McpClient;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "mcpClient.servers": () => McpServerView[];
    "mcpClient.reconnect": (id: string) => McpServerView[];
    /** Connect with a configuration that is not saved yet, list its tools, disconnect. */
    "mcpClient.test": (server: unknown) => McpTestResult;
    /** Another client's `mcpServers` JSON as configurations, with ids that do not collide with the saved ones. */
    "mcpClient.parseConfig": (text: string) => { servers: McpServerConfig[]; errors: string[] };
  }
  interface Broadcasts {
    "mcpClient.changed": (servers: McpServerView[]) => void;
  }
}

interface Link {
  config: McpServerConfig;
  signature: string;
  state: McpServerState;
  error?: string;
  server?: ServerInfo;
  connection?: Connection;
  tools: McpToolView[];
  unregister: (() => void)[];
  /** Set once the link is replaced or removed; late results from its connection are thrown away. */
  retired: boolean;
  attempts: number;
  retry?: { attempt: number; of: number };
  timer?: ReturnType<typeof setTimeout>;
  connectedAt?: number;
}


function describe(serverId: string, tool: RemoteTool, exact: boolean): string {
  const lines = [tool.description?.trim() || tool.title || tool.name, `(From the MCP server "${serverId}".)`];
  if (!exact) lines.push(`Arguments (JSON Schema): ${JSON.stringify(tool.inputSchema)}`);
  return lines.join("\n\n");
}

/**
 * Keeps one connection per configured server and the server's tools in
 * `ctx.tools`, in step with the `mcpServers` settings section. A server that
 * fails is marked failed with its reason and holds nothing else up.
 */
export class McpClient extends Service {
  static provide = "mcpClient";
  static inject = ["tools", "settings"];
  static Config = McpClientConfig;

  private links = new Map<string, Link>();
  private pending: Promise<void> = Promise.resolve();
  private notify: () => void = () => {};
  private disposed = false;
  /** Registrations and listeners belong to this plugin, whoever calls in. */
  private readonly home: Context;

  constructor(
    ctx: Context,
    public readonly config: McpClientConfig
  ) {
    super(ctx, "mcpClient");
    this.home = ctx;
  }

  [Service.init]() {
    this.home.settings.register(MCP_SERVERS_SECTION);
    this.home.on("settings/changed", () => void this.reconcile());
    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("mcpClient.servers", () => this.servers());
      ctx.ipc.handle("mcpClient.reconnect", async (id) => {
        await this.reconnect(id);
        return this.servers();
      });
      ctx.ipc.handle("mcpClient.test", (server) => this.test(server));
      ctx.ipc.handle("mcpClient.parseConfig", (text) => parseClientConfig(text, this.configured().map((s) => s.id)));
      this.notify = () => ctx.ipc.send("mcpClient.changed", this.servers());
      return () => {
        this.notify = () => {};
      };
    });
    void this.reconcile();
    return () => {
      this.disposed = true;
      for (const link of this.links.values()) this.retire(link);
      this.links.clear();
    };
  }

  /** Resolves once every connection the last change started has either connected or failed. */
  settled(): Promise<void> {
    return this.pending;
  }

  servers(): McpServerView[] {
    return this.configured()
      .map((config) => this.links.get(config.id))
      .filter((link): link is Link => !!link)
      .map((link) => ({
        id: link.config.id,
        enabled: link.config.enabled,
        transport: link.config.transport.type,
        target: targetOf(link.config),
        state: link.state,
        error: link.error,
        server: link.server,
        tools: link.tools,
        retry: link.retry
      }));
  }

  async reconnect(id: string): Promise<void> {
    const link = this.links.get(id);
    if (!link) throw new Error(`no MCP server "${id}"`);
    this.retire(link);
    this.links.delete(id);
    await this.reconcile();
  }

  async test(raw: unknown): Promise<McpTestResult> {
    const parsed = McpServerConfig.safeParse(raw);
    if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join(".") || "server"}: ${i.message}`).join("; ") };
    const connection = new Connection(parsed.data, { onClose: () => {}, onToolsChanged: () => {} });
    try {
      await connection.open();
      return { ok: true, server: connection.server(), tools: (await connection.tools()).map((t) => t.name) };
    } catch (e) {
      return { ok: false, error: errorMessage(e) };
    } finally {
      await connection.close();
    }
  }

  private configured(): McpServerConfig[] {
    const parsed = McpClientSettings.safeParse(this.home.settings.get()[MCP_SERVERS_SECTION.id]);
    if (parsed.success) return parsed.data.servers;
    this.home.logger.warn(`mcpServers settings ignored: ${parsed.error.message}`);
    return [];
  }

  /** Settings change for many reasons; a server is touched only when its own configuration did. */
  private reconcile(): Promise<void> {
    if (this.disposed) return this.pending;
    const wanted = this.configured();
    const ids = new Set(wanted.map((s) => s.id));
    for (const [id, link] of this.links) {
      if (ids.has(id)) continue;
      this.retire(link);
      this.links.delete(id);
    }
    const started: Promise<void>[] = [];
    for (const config of wanted) {
      const signature = JSON.stringify(config);
      const existing = this.links.get(config.id);
      if (existing?.signature === signature) continue;
      if (existing) this.retire(existing);
      const link: Link = { config, signature, state: config.enabled ? "connecting" : "off", tools: [], unregister: [], retired: false, attempts: 0 };
      this.links.set(config.id, link);
      if (config.enabled) started.push(this.connect(link));
    }
    this.notify();
    this.pending = Promise.all([this.pending, ...started]).then(() => {});
    return this.pending;
  }

  private async connect(link: Link): Promise<void> {
    link.state = "connecting";
    this.notify();
    const connection = new Connection(link.config, {
      onClose: (reason) => {
        if (link.retired || link.connection !== connection) return;
        this.unregister(link);
        link.connection = undefined;
        this.fail(link, reason);
        this.notify();
      },
      onToolsChanged: () => {
        if (!link.retired && link.connection === connection) void this.register(link, connection).then(() => this.notify(), () => {});
      }
    });
    try {
      await connection.open();
      if (link.retired) return void (await connection.close());
      link.connection = connection;
      link.server = connection.server();
      await this.register(link, connection);
      if (link.retired) return;
      link.state = "connected";
      link.error = undefined;
      link.retry = undefined;
      link.connectedAt = Date.now();
    } catch (e) {
      await connection.close();
      if (link.retired) return;
      link.connection = undefined;
      this.unregister(link);
      this.fail(link, errorMessage(e));
    }
    this.notify();
  }

  /** Marks the link failed and, while retries remain, schedules the next attempt. */
  private fail(link: Link, reason: string): void {
    link.state = "failed";
    link.error = reason;
    if (link.connectedAt !== undefined && Date.now() - link.connectedAt >= this.config.stableMs) link.attempts = 0;
    link.connectedAt = undefined;
    const delay = this.config.retryDelaysMs[link.attempts];
    if (delay === undefined || this.disposed) {
      link.retry = undefined;
      return;
    }
    link.attempts += 1;
    link.retry = { attempt: link.attempts, of: this.config.retryDelaysMs.length };
    link.timer = setTimeout(() => {
      link.timer = undefined;
      if (!link.retired) void this.connect(link);
    }, delay);
  }

  /** (Re)lists the server's tools and registers them; a name taken by anyone else is skipped, never thrown. */
  private async register(link: Link, connection: Connection): Promise<void> {
    const remote = await connection.tools();
    if (link.retired) return;
    this.unregister(link);
    const allow = link.config.tools ? new Set(link.config.tools) : null;
    const views: McpToolView[] = [];
    for (const tool of remote) {
      if (allow && !allow.has(tool.name)) continue;
      const name = toolName(link.config.id, tool.name);
      const view: McpToolView = { name, remote: tool.name, title: tool.title, description: tool.description };
      views.push(view);
      if (this.home.tools.has(name)) {
        view.skipped = `the name "${name}" is already taken`;
        continue;
      }
      const { schema, exact } = inputSchemaOf(tool.inputSchema);
      if (!exact) view.approximate = true;
      link.unregister.push(
        this.home.tools.register(
          defineTool({
            name,
            title: tool.title ?? tool.name,
            description: describe(link.config.id, tool, exact),
            input: schema,
            execute: (args, invocation) => connection.call(tool.name, args, invocation.signal)
          })
        )
      );
    }
    for (const missing of allow ?? []) {
      if (!remote.some((t) => t.name === missing)) views.push({ name: toolName(link.config.id, missing), remote: missing, skipped: "the server does not offer it" });
    }
    link.tools = views;
  }

  private unregister(link: Link): void {
    for (const off of link.unregister.splice(0)) off();
  }

  private retire(link: Link): void {
    link.retired = true;
    clearTimeout(link.timer);
    this.unregister(link);
    const connection = link.connection;
    link.connection = undefined;
    void connection?.close();
  }
}
