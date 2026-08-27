import { Context, Service } from "cordis";
import { z } from "zod";
import type { Author } from "@tomrade/domain";

export interface ToolInvocation {
  by: Author;
  /** The project the caller is scoped to; tools default their filters to it. */
  projectId?: string;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  execute(args: z.output<S>, invocation: ToolInvocation): unknown;
}

export interface ToolCall {
  name: string;
  args: unknown;
  by: Author;
  projectId?: string;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: unknown };

/** Model-facing description of a tool: what every surface (assistant prompt, MCP listing) is generated from. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

declare module "cordis" {
  interface Context {
    tools: Tools;
  }
  interface Events {
    "tools/pre-execute"(call: ToolCall, next: () => Promise<unknown>): Promise<unknown>;
    "tools/result"(call: ToolCall, outcome: ToolOutcome): void;
  }
}

export const defineTool = <S extends z.ZodObject>(tool: ToolDefinition<S>): ToolDefinition<S> => tool;

export class ToolInputError extends Error {
  constructor(
    public readonly tool: string,
    public readonly issues: z.core.$ZodIssue[]
  ) {
    super(`${tool}: invalid arguments — ${issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    this.name = "ToolInputError";
  }
}

export class UnknownToolError extends Error {
  constructor(public readonly tool: string) {
    super(`Unknown tool: ${tool}`);
    this.name = "UnknownToolError";
  }
}

export class Tools extends Service {
  static provide = "tools";

  private registry = new Map<string, ToolDefinition>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /** Reversible: the tool is removed when the registering plugin unloads. */
  register<S extends z.ZodObject>(tool: ToolDefinition<S>): () => void {
    if (this.registry.has(tool.name)) throw new Error(`tool "${tool.name}" is already registered`);
    return this.ctx.effect(() => {
      this.registry.set(tool.name, tool as unknown as ToolDefinition);
      return () => this.registry.delete(tool.name);
    }, `tools.register(${tool.name})`);
  }

  list(): ToolDefinition[] {
    return [...this.registry.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.registry.get(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  describe(): ToolDescriptor[] {
    return this.list().map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: z.toJSONSchema(t.input) }));
  }

  /** Validate, pass the tools/pre-execute gate, run, and report the outcome. */
  async execute(name: string, rawArgs: unknown, invocation: ToolInvocation): Promise<unknown> {
    const tool = this.registry.get(name);
    if (!tool) throw new UnknownToolError(name);
    const parsed = tool.input.safeParse(rawArgs ?? {});
    if (!parsed.success) throw new ToolInputError(name, parsed.error.issues);
    const call: ToolCall = { name, args: parsed.data, by: invocation.by, projectId: invocation.projectId };
    try {
      const result = await this.ctx.waterfall("tools/pre-execute", call, async () => tool.execute(parsed.data, invocation));
      this.ctx.emit("tools/result", call, { ok: true, result });
      return result;
    } catch (error) {
      this.ctx.emit("tools/result", call, { ok: false, error });
      throw error;
    }
  }
}
