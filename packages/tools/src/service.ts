import { Context, Service } from "cordis";
import { z } from "zod";
import type { Author } from "@tomradex/domain";
import { writeContext } from "@tomradex/write";

/** One tool call as the run's ledger remembers it. */
export interface LedgerEntry {
  seq: number;
  tool: string;
  args: unknown;
  ok: boolean;
  /** One line of what came back (or the error message). */
  summary: string;
  ms: number;
}

/**
 * One agent run, as tools and policies see it. Every write made while a tool
 * executes under a run is stamped with `id` in the oplog, which is what makes
 * the whole run revertible at once.
 */
export interface RunHandle {
  id: string;
  threadId: string;
  projectId: string;
  author: Author;
  ledger: {
    all(): LedgerEntry[];
    find(pred: (entry: LedgerEntry) => boolean): LedgerEntry | undefined;
  };
  /** Rule ids the user explicitly waived for this run (through ask_user). */
  waivers: Set<string>;
  /** Run-scoped scratch space; proposals live here between tool calls. */
  scratch: Map<string, unknown>;
}

export interface ToolInvocation {
  by: Author;
  /** The project the caller is scoped to; tools default their filters to it. */
  projectId?: string;
  /** Present when the call belongs to an agent run; policies read its ledger. */
  run?: RunHandle;
  /** Aborted when the caller stops waiting — a cancelled run, a client that withdrew the call. Work outside the process should stop with it. */
  signal?: AbortSignal;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  execute(args: z.output<S>, invocation: ToolInvocation): unknown;
  /** How to undo this tool's non-oplog effects; undoRun calls it for ledger entries whose tool declares one. */
  revert?(args: z.output<S>, result: unknown, invocation: ToolInvocation): void | Promise<void>;
}

export interface ToolCall {
  name: string;
  args: unknown;
  by: Author;
  projectId?: string;
  run?: RunHandle;
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

/**
 * Tools scope to the caller's project. Without one there is nothing to default
 * to — guessing would write into the wrong project the moment a second exists —
 * so the call is refused with the tool that answers the question.
 */
export function requireProjectId(tool: string, given: string | undefined, invocation: { projectId?: string }): string {
  const id = given ?? invocation.projectId;
  if (!id) {
    throw new ToolInputError(tool, [{ code: "custom", path: ["projectId"], message: "required here — call list_projects and pass one", input: undefined } as unknown as z.core.$ZodIssue]);
  }
  return id;
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
    const call: ToolCall = { name, args: parsed.data, by: invocation.by, projectId: invocation.projectId, run: invocation.run };
    try {
      const gated = () => this.ctx.waterfall("tools/pre-execute", call, async () => tool.execute(parsed.data, invocation));
      // Writes made anywhere under this call carry the run id in the oplog.
      const result = await (invocation.run ? writeContext.run({ runId: invocation.run.id, author: invocation.by }, gated) : gated());
      this.ctx.emit("tools/result", call, { ok: true, result });
      return result;
    } catch (error) {
      this.ctx.emit("tools/result", call, { ok: false, error });
      throw error;
    }
  }
}
