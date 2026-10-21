import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { searchPath } from "@tomradex/engine-kit";
import type { McpServerConfig } from "./config.js";
import { errorMessage } from "@tomradex/contracts";

export interface RemoteTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: unknown;
}

export interface ServerInfo {
  name: string;
  version: string;
}

interface Handlers {
  /** The server went away without being asked to. */
  onClose(reason: string): void;
  onToolsChanged(): void;
}

const CONNECT_TIMEOUT_MS = 30_000;
const STDERR_KEEP = 2_000;


type Content = { type: string; text?: string; mimeType?: string; uri?: string; name?: string; resource?: { uri: string; text?: string } };

function textOf(content: Content[] | undefined): string {
  return (content ?? [])
    .map((c) => {
      if (c.type === "text") return c.text ?? "";
      if (c.type === "resource") return c.resource?.text ?? `[resource ${c.resource?.uri ?? ""}]`;
      if (c.type === "resource_link") return `[${c.name ?? "resource"}: ${c.uri ?? ""}]`;
      return `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""}]`;
    })
    .join("\n");
}

/** One live connection to one server. Each attempt gets a fresh `Client`: a client that failed to connect is not reused. */
export class Connection {
  private client: Client | null = null;
  private closing = false;
  private stderr = "";

  constructor(
    private readonly config: McpServerConfig,
    private readonly handlers: Handlers
  ) {}

  async open(): Promise<void> {
    const t = this.config.transport;
    if (t.type === "stdio") {
      const transport = new StdioClientTransport({
        command: t.command,
        args: t.args,
        env: { ...getDefaultEnvironment(), PATH: searchPath().join(path.delimiter), ...t.env },
        cwd: t.cwd,
        stderr: "pipe"
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        this.stderr = (this.stderr + chunk.toString("utf8")).slice(-STDERR_KEEP);
      });
      await this.attach(transport).catch((e) => {
        throw new Error(this.explain(e));
      });
      return;
    }
    const init = { headers: t.headers };
    try {
      await this.attach(new StreamableHTTPClientTransport(new URL(t.url), { requestInit: init }));
    } catch (streamable) {
      // Servers written before Streamable HTTP speak the older SSE transport on the same URL.
      try {
        await this.attach(
          new SSEClientTransport(new URL(t.url), {
            requestInit: init,
            eventSourceInit: { fetch: (url, options) => fetch(url, { ...options, headers: { ...(options?.headers as Record<string, string>), ...t.headers } }) }
          })
        );
      } catch {
        throw streamable;
      }
    }
  }

  private async attach(transport: Transport): Promise<void> {
    const client = new Client(
      { name: "tomrade", version: "0.0.1" },
      { listChanged: { tools: { autoRefresh: false, onChanged: () => this.handlers.onToolsChanged() } } }
    );
    client.onclose = () => {
      if (this.client !== client || this.closing) return;
      this.client = null;
      this.handlers.onClose(this.explain(new Error(this.config.transport.type === "stdio" ? "the server exited" : "the connection closed")));
    };
    try {
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
    } catch (e) {
      await client.close().catch(() => {});
      throw e;
    }
    this.client = client;
  }

  /** A spawn failure or an early exit says more with what the server printed before it went. */
  private explain(e: unknown): string {
    const t = this.config.transport;
    const code = (e as { code?: string }).code;
    let base = errorMessage(e);
    if (t.type === "stdio" && code === "ENOENT") base = `command not found: ${t.command}`;
    else if (t.type === "stdio" && /Connection closed/.test(base)) base = "the server exited before it was ready";
    const tail = this.stderr.trim().split("\n").slice(-3).join("\n");
    return tail ? `${base}\n${tail}` : base;
  }

  server(): ServerInfo | undefined {
    const info = this.client?.getServerVersion();
    return info ? { name: info.name, version: info.version } : undefined;
  }

  async tools(): Promise<RemoteTool[]> {
    const client = this.live();
    const out: RemoteTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.config.timeoutMs });
      for (const tool of page.tools) out.push({ name: tool.name, title: tool.title ?? tool.annotations?.title, description: tool.description, inputSchema: tool.inputSchema });
      cursor = page.nextCursor;
    } while (cursor);
    return out;
  }

  /** A string when the server answered in text, its structured content when that is all it sent; an error result throws. */
  async call(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const result = await this.live().callTool({ name, arguments: args as Record<string, unknown> }, undefined, { timeout: this.config.timeoutMs, signal });
    const text = textOf(result.content as Content[] | undefined);
    if (result.isError) throw new Error(text || `${name} reported an error`);
    if (!text && result.structuredContent !== undefined) return result.structuredContent;
    return text;
  }

  async close(): Promise<void> {
    this.closing = true;
    const client = this.client;
    this.client = null;
    await client?.close().catch(() => {});
  }

  private live(): Client {
    if (!this.client) throw new Error(`MCP server "${this.config.id}" is not connected`);
    return this.client;
  }
}
