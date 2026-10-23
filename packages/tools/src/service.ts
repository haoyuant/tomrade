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
  /** Where the run works once its turn is prepared: the thread's workstream checkout. */
  cwd?: string;
  /** Credentials plugins supplied for the run's subprocesses; never persisted. */
  env?: Record<string, string>;
}

export interface ToolInvocation {
  by: Author;
  /** The project the caller is scoped to; tools default their filters to it. */
  projectId?: string;
  /** Present when the call belongs to an agent run; policies read its ledger. */
  run?: RunHandle;
  /** Aborted when the caller stops waiting — a cancelled run, a client that withdrew the call. Work outside the process should stop with it. */
  signal?: AbortSignal;
  /**
   * The outside client's connection the call came over (its MCP session id):
   * the same for every call one agent process makes until it reconnects,
   * whichever agent it is. Absent for calls made inside this process.
   */
  connection?: string;
  /** The folders an outside client says it works in (its MCP roots), as absolute paths. Absent when the client declares none. */
  roots?(): Promise<string[]>;
  /** Ask the person behind the call to pick one of `options`; null when the call was cancelled. Absent when nobody can be asked. */
  ask?(text: string, options: string[]): Promise<string | null>;
}

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  input: S;
  execute(args: z.output<S>, invocation: ToolInvocation): unknown;
  /**
   * False keeps the tool off the MCP server, so only engines in this process can call it — for what no outside client may reach, like a shell.
   * "run" serves it only to a Tomrade conversation's own agent (a run-bound session), never to an outside client.
   */
  mcp?: boolean | "run";
  /** True when the tool only reads: MCP clients such as Codex then run it without asking (`readOnlyHint`). */
  readOnly?: boolean;
  /** The result is reference the model needs in full — a schema, a playbook: never compacted into short rows, and the loop reads up to 100k characters of it. */
  whole?: boolean;
  /**
   * Listed to an in-process agent only on threads of this surface (the
   * troubleshooter's tools: "doctor"), so no other conversation carries it.
   * The MCP server still serves it; the tool refuses calls from elsewhere.
   */
  surface?: string;
  /**
   * A kit of tools few conversations use (routines, plugins, diagrams…). A
   * conversation whose kind does not carry the kit is offered it on request:
   * the engine loads it when the model asks, or opens a playbook naming it.
   */
  kit?: string;
  /** How to undo this tool's non-oplog effects; undoRun calls it for ledger entries whose tool declares one. */
  revert?(args: z.output<S>, result: unknown, invocation: ToolInvocation): void | Promise<void>;
}

export interface ToolCall {
  name: string;
  args: unknown;
  by: Author;
  projectId?: string;
  run?: RunHandle;
  /** The outside client's connection the call came over, when it came from one: that agent process's MCP session. */
  connection?: string;
}

export type ToolOutcome = { ok: true; result: unknown } | { ok: false; error: unknown };

/** Model-facing description of a tool: what every surface (assistant prompt, MCP listing) is generated from. */
export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  whole?: boolean;
  kit?: string;
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

/** Names agents reach for that a tool spells differently. */
const ALIASES: Record<string, string[]> = { query: ["search"], q: ["search"], text: ["search", "body"], itemId: ["id"], key: ["id"], ticket: ["id"], ticketId: ["id"], description: ["body"], content: ["body"], blockedBy: ["blocks"], parent: ["parentId"] };

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const next = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = row[j];
      row[j] = next;
    }
  }
  return row[b.length];
}

/** The accepted name a mistyped one most likely meant, if any is close. */
export function nearestParam(given: string, accepted: string[]): string | undefined {
  const alias = ALIASES[given]?.find((name) => accepted.includes(name));
  if (alias) return alias;
  const lower = given.toLowerCase();
  const scored = accepted.map((name) => ({ name, d: distance(lower, name.toLowerCase()) })).sort((x, y) => x.d - y.d);
  return scored[0] && scored[0].d <= Math.max(1, Math.floor(given.length / 3)) ? scored[0].name : undefined;
}

const strictCache = new WeakMap<z.ZodType, z.ZodType>();

/**
 * The schema refusing keys it does not declare, at every depth. Zod strips them by default, so a
 * misspelt parameter (query for search) used to vanish and the call answered something else.
 */
export function strictInput<S extends z.ZodType>(schema: S): S {
  const cached = strictCache.get(schema);
  if (cached) return cached as S;
  const out = tighten(schema);
  strictCache.set(schema, out);
  return out as S;
}

function tighten(schema: z.ZodType): z.ZodType {
  // An extension's schema may come from another zod; it is left as it is.
  if (!schema?._zod?.def) return schema;
  const def = schema._zod.def as { type: string; innerType?: z.ZodType; element?: z.ZodType; catchall?: z.ZodType; error?: (issue: unknown) => unknown };
  const withDef = (next: object) => (schema as unknown as { clone(def: object, params: { parent: true }): z.ZodType }).clone({ ...def, ...next }, { parent: true });
  switch (def.type) {
    case "object": {
      // A schema that already says what to do with other keys (loose, catchall) keeps saying it.
      if (def.catchall) return schema;
      const shape = Object.fromEntries(Object.entries((schema as z.ZodObject).shape).map(([key, value]) => [key, tighten(value as z.ZodType)]));
      const accepted = Object.keys(shape);
      return withDef({
        shape,
        catchall: z.never(),
        error: (issue: { code: string; keys?: string[] }) => {
          if (issue.code !== "unrecognized_keys" || !issue.keys) return def.error?.(issue);
          const hints = issue.keys.map((key) => {
            const near = nearestParam(key, accepted);
            return near ? `"${key}" (did you mean "${near}"?)` : `"${key}"`;
          });
          return `unknown parameter${issue.keys.length > 1 ? "s" : ""} ${hints.join(", ")} — accepted: ${accepted.join(", ")}`;
        }
      });
    }
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly": {
      const inner = tighten(def.innerType!);
      return inner === def.innerType ? schema : withDef({ innerType: inner });
    }
    case "array": {
      const element = tighten(def.element!);
      return element === def.element ? schema : withDef({ element });
    }
    default:
      return schema;
  }
}

/**
 * Tools scope to the caller's project. Without one there is nothing to default
 * to — guessing would write into the wrong project the moment a second exists —
 * so the call is refused with the tool that answers the question.
 */
/**
 * The project a call works in. A call bound to one (an assistant thread's run,
 * a project's MCP session) stays in it: naming another is refused, so an agent
 * cannot wander into a project the user is not looking at.
 */
export function requireProjectId(tool: string, given: string | undefined, invocation: { projectId?: string }): string {
  if (given && invocation.projectId && given !== invocation.projectId) {
    throw new ToolInputError(tool, [{ code: "custom", path: ["projectId"], message: `"${given}" is another project — this conversation works only in its own project ("${invocation.projectId}"); omit projectId, and if the user means another project, tell them to open it there`, input: given } as unknown as z.core.$ZodIssue]);
  }
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
  private kitNotes = new Map<string, string>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  /** What a kit is for, in a few words the model reads before it loads the kit ("recurring tickets on a schedule"). Reversible. */
  kit(id: string, purpose: string): () => void {
    return this.ctx.effect(() => {
      this.kitNotes.set(id, purpose);
      return () => this.kitNotes.delete(id);
    }, `tools.kit(${id})`);
  }

  kits(): Record<string, string> {
    return Object.fromEntries(this.kitNotes);
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

  /** What the MCP server offers: every tool but those kept in this process; a conversation's own agent also gets the "run" ones. */
  served(audience: "public" | "run" = "public"): ToolDefinition[] {
    return this.list().filter((t) => t.mcp !== false && (t.mcp !== "run" || audience === "run"));
  }

  get(name: string): ToolDefinition | undefined {
    return this.registry.get(name);
  }

  has(name: string): boolean {
    return this.registry.has(name);
  }

  describe(): ToolDescriptor[] {
    // `$schema` names the draft in every tool, and the model pays for it in every request.
    return this.list().map((t) => {
      const { $schema: _, ...inputSchema } = z.toJSONSchema(t.input);
      return { name: t.name, title: t.title, description: t.description, inputSchema, ...(t.whole ? { whole: true } : {}), ...(t.kit ? { kit: t.kit } : {}) };
    });
  }

  /** Validate, pass the tools/pre-execute gate, run, and report the outcome. */
  async execute(name: string, rawArgs: unknown, invocation: ToolInvocation): Promise<unknown> {
    const tool = this.registry.get(name);
    if (!tool) throw new UnknownToolError(name);
    const parsed = strictInput(tool.input).safeParse(rawArgs ?? {});
    if (!parsed.success) throw new ToolInputError(name, parsed.error.issues);
    const call: ToolCall = { name, args: parsed.data, by: invocation.by, projectId: invocation.projectId, run: invocation.run, ...(invocation.connection ? { connection: invocation.connection } : {}) };
    try {
      const gated = () =>
        this.ctx.waterfall("tools/pre-execute", call, async () => {
          if (call.args === parsed.data) return tool.execute(parsed.data, invocation);
          // A policy replaced the arguments: they answer to the tool's input as the caller's did.
          const again = strictInput(tool.input).safeParse(call.args ?? {});
          if (!again.success) throw new ToolInputError(name, again.error.issues);
          call.args = again.data;
          return tool.execute(again.data, invocation);
        });
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
