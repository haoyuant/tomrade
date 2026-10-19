import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "cordis";
import type { AgentRequest } from "@tomradex/agent";
import type {} from "@tomradex/alerts";
import type {} from "@tomradex/im";
import type {} from "@tomradex/boards";
import type { Words } from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/desktop-surface";
import type {} from "@tomradex/fields";
import type {} from "@tomradex/items";
import { OpenAiCompatible, listModels, type ChatModel, type ModelProviderSpec as CoreModelProvider } from "@tomradex/llm";
import type {} from "@tomradex/oplog";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/tools";
import type {} from "@tomradex/herdr";
import type {} from "@tomradex/web-search";
import { extensionScope, type WriteIntent } from "@tomradex/write";
import {
  assertOwned,
  type AgentApi,
  type AlertsApi,
  type ImApi,
  type BoardsApi,
  type ContributionsApi,
  type DbApi,
  type Disposer,
  type Events,
  type FieldsApi,
  type ItemsApi,
  type Locale,
  type Localized,
  type CompatibleModelOptions,
  type ModelChat,
  type ModelChatEvent,
  type ModelProviderSpec,
  type ModelRequest,
  type ModelsApi,
  type ModelRequestChange,
  type OplogApi,
  type PendingWrite,
  type TerminalsApi,
  type WebSearchApi,
  type PluginContext,
  type ProjectsApi,
  type ServiceName,
  type SettingsApi,
  type SqlParams,
  type SurfacesApi,
  type ToolCallInfo,
  type ToolsApi,
  type ViewsApi
} from "@tomradex/plugin-sdk";
import { wordsFor } from "@tomradex/plugin-sdk";
import { authorFor, scopeFor, within, withTimeout } from "./scope.js";

export interface ExtensionIdentity {
  /** `publisher/name` for an extension, the row id for a built-in. */
  id: string;
  namespace: string;
  /** An extension came from outside the app and is held to its namespace. */
  origin: "builtin" | "extension";
  /** Where the plugin's own files are: surface documents resolve against it. */
  root: string | null;
  dataDir: string | null;
  /** The plugin's title, carried by every window it opens. */
  title?: string;
  /** Its manifest grants `permissions.window`; a built-in needs none. */
  window?: boolean;
}

/** What a plugin's window is called: its own title, then the plugin's, so it never passes for Tomrade's or another app's. */
export const windowTitle = (title: string, owner: string | undefined): string => (owner && title !== owner ? `${title} — ${owner}` : title);

const CORDIS: Record<ServiceName, string> = {
  items: "items",
  fields: "fields",
  boards: "boards",
  views: "views",
  projects: "projects",
  db: "db",
  settings: "settings",
  tools: "tools",
  contributions: "contributions",
  agent: "agent",
  im: "im",
  surfaces: "desktopSurfaces",
  alerts: "alerts",
  oplog: "oplog",
  webSearch: "webSearch",
  terminals: "herdr",
  models: "llm"
};

export const cordisName = (name: ServiceName): string => CORDIS[name];

interface Services {
  items: Context["items"];
  fields: Context["fields"];
  boards: Context["boards"];
  views: Context["views"];
  projects: Context["projects"];
  db: Context["db"];
  settings: Context["settings"];
  tools: Context["tools"];
  contributions: Context["contributions"];
  agent: Context["agent"];
  im: Context["im"];
  surfaces: Context["desktopSurfaces"];
  alerts: Context["alerts"];
  oplog: Context["oplog"];
  webSearch: Context["webSearch"];
  terminals: Context["herdr"];
  models: Context["llm"];
}

/** A render callback has this long before its contribution is dropped for the refresh. */
export const RENDER_MS = 2_000;
export const COMMAND_MS = 60_000;
/** A hook in the agent's loop has this long before the step goes on without it. */
export const HOOK_MS = 10_000;
/** A CLI agent waits five seconds for Tomrade's answer to its hook; a plugin's comes inside that, or not at all. */
export const CLI_HOOK_MS = 3_000;

type Fn = (...args: never[]) => unknown;

const spread = (params: SqlParams | undefined): unknown[] => (params === undefined ? [] : Array.isArray(params) ? params : [params]);

/** What a policy is shown: its own copy where the value allows one, so a change of its reaches nothing. */
/** A request as a plugin's hook sees it: plain data, its own copy. */
const modelRequest = (request: AgentRequest): ModelRequest => copy({ system: request.system, tools: request.tools, messages: request.messages, turn: request.turn }) as ModelRequest;

/** Only the parts a hook may change, and only when they are the right shape. */
const changeOf = (change: ModelRequestChange): Partial<Pick<AgentRequest, "system" | "tools" | "messages">> => ({
  ...(typeof change.system === "string" ? { system: change.system } : {}),
  ...(Array.isArray(change.tools) ? { tools: change.tools } : {}),
  ...(Array.isArray(change.messages) ? { messages: change.messages as AgentRequest["messages"] } : {})
});

const copy = <T>(value: T): T => {
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
};

/** A plugin's headers as fetch takes them; anything but an object of names and values is refused. */
const strings = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be an object of names and values");
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
};

/**
 * One plugin's view of the app. It hands out nothing live: every method is a
 * call made inside the plugin's scope and answered with a Promise, every
 * function the plugin registers is called back inside that scope, and every
 * id it registers is checked against its namespace.
 */
export class Host {
  readonly context: PluginContext;

  constructor(
    private readonly ctx: Context,
    private readonly identity: ExtensionIdentity,
    private readonly allowed: ReadonlySet<ServiceName>
  ) {
    this.context = this.build();
  }

  private get ns(): string {
    return this.identity.namespace;
  }

  private own(id: string, kind: string): void {
    if (this.identity.origin === "extension") assertOwned(this.ns, id, kind);
  }

  /** The app's language; English where settings are not loaded. */
  private locale(): Locale {
    return (this.ctx.get("settings") as Context["settings"] | undefined)?.locale() ?? "en";
  }

  /** Per-language text becomes words the core reads each time it shows them, so a switch shows at once. */
  private say<W extends Localized | undefined>(w: W): W extends undefined ? undefined : Words {
    return (w === undefined || typeof w === "string" ? w : () => wordsFor(this.locale(), w)) as never;
  }

  private svc<K extends ServiceName>(name: K): Services[K] {
    if (!this.allowed.has(name)) throw new Error(`${this.identity.id} did not name "${name}" in inject or optional`);
    const value = this.ctx.get(CORDIS[name]);
    if (value === undefined) throw new Error(`${this.identity.id}: "${name}" is not available right now`);
    return value as never;
  }

  private call<T>(fn: () => T): Promise<Awaited<T>> {
    return within(this.ns, fn);
  }

  /** Wraps a function the plugin gave the host so the host can call it back safely. */
  private back<F extends Fn>(fn: F, label: string, opts: { human?: boolean; ms?: number | null } = {}) {
    return (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> =>
      withTimeout(within(this.ns, () => fn(...args) as ReturnType<F>, opts.human ?? false), opts.ms ?? null, `${this.identity.id} ${label}`);
  }

  /** A callback the host must answer at once (the core asks it synchronously): run in the plugin's scope, a throw read as `failed`. */
  private now<T>(fn: () => T, label: string, failed: (message: string) => T): T {
    try {
      return extensionScope.run(scopeFor(this.ns), fn);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${this.identity.id} ${label}: ${message}`);
      return failed(message);
    }
  }

  /**
   * A write gate is asked inside the write's transaction, so it answers at once: a throw refuses the
   * write, and a Promise is not waited for. It sees a copy, so no change of its reaches later policies.
   */
  private judge(check: (write: PendingWrite) => unknown, intent: WriteIntent): void {
    const write: PendingWrite = copy({
      projectId: intent.projectId, entity: intent.entity, op: intent.op, id: intent.id, by: intent.by, via: intent.via ?? null, runId: intent.runId ?? null,
      baseVersion: intent.baseVersion ?? null, before: intent.before, after: intent.after, patch: intent.patch ?? null
    });
    const answer = extensionScope.run(scopeFor(this.ns), () => check(write));
    if (typeof (answer as PromiseLike<unknown> | undefined)?.then === "function") {
      Promise.resolve(answer).catch(() => {});
      this.logger.warn(`${this.identity.id} write gate answered with a Promise; a write gate must answer at once, so ${intent.entity} ${intent.id} was written without its answer`);
    }
  }

  /** A hook's answer, or none when it threw or ran out of time: a plugin's hook never ends the agent's turn. */
  private async hooked<T>(fn: () => Promise<T>, label: string): Promise<T | undefined> {
    try {
      return await fn();
    } catch (error) {
      this.logger.warn(`${this.identity.id} ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Fire-and-forget: a listener that throws is logged, never propagated into the host's emit. */
  private listen<F extends Fn>(fn: F, label: string) {
    const wrapped = this.back(fn, label);
    return (...args: Parameters<F>) => {
      wrapped(...args).catch((error: unknown) => this.logger.warn(`${label}: ${error instanceof Error ? error.message : String(error)}`));
    };
  }

  private get logger() {
    return this.ctx.logger(this.identity.id);
  }

  /** A stream the plugin yields, each step pulled inside its scope. */
  private async *pulled<T>(open: () => AsyncIterable<T>): AsyncGenerator<T> {
    const it = await within(this.ns, () => open()[Symbol.asyncIterator]());
    let done = false;
    try {
      for (;;) {
        const step = await within(this.ns, () => it.next());
        if (step.done) {
          done = true;
          return;
        }
        yield step.value;
      }
    } finally {
      // A turn cut short (aborted, or the caller stopped reading) lets the plugin clean up.
      if (!done) await within(this.ns, () => it.return?.()).catch(() => {});
    }
  }

  /** A plugin's model provider as core reads one: every call back runs in its scope, and what it leaves out takes the defaults. */
  private modelProvider(spec: ModelProviderSpec): CoreModelProvider {
    const host = this;
    const label = `model provider ${spec.id}`;
    const both = (w: Localized | undefined) => (w === undefined ? { en: "", zh: "" } : typeof w === "string" ? { en: w, zh: w } : { en: wordsFor("en", w), zh: wordsFor("zh", w) });
    const signIn = spec.signIn ? this.back(spec.signIn.run.bind(spec.signIn), `${label} sign-in`) : null;
    const chatOf = (model: ModelChat): ChatModel => ({
      get capabilities() {
        return host.now(() => copy(model.capabilities), `${label} capabilities`, () => ({ tools: false, streaming: true, json: false }));
      },
      // its own copy of the conversation, so nothing it changes reaches the transcript
      chat: (request, signal) => host.pulled<ModelChatEvent>(() => model.chat(copy(request), signal))
    });
    return {
      id: spec.id,
      title: both(spec.title),
      keyRequired: spec.keyRequired ?? true,
      baseURL: { default: spec.baseURL.default, editable: spec.baseURL.editable ?? true },
      chat: spec.chat ?? true,
      presets: (spec.presets ?? []).map((p) => ({
        id: p.id,
        title: p.title,
        // none: the provider's own default, as it is for a profile without an address
        baseURL: p.baseURL ?? "",
        model: p.model ?? "",
        prefer: p.prefer ?? [],
        ...(p.keyPage ? { keyPage: p.keyPage } : {}),
        ...(p.env ? { env: p.env } : {}),
        ...(p.keyShapes ? { keyShapes: p.keyShapes } : {}),
        ...(p.local ? { local: true } : {}),
        hint: both(p.hint)
      })),
      list: async (endpoint, timeoutMs = 15_000) => {
        try {
          // held to the time even when the plugin does not listen to the signal
          const listed = await this.back(spec.list.bind(spec), `${label} list`, { ms: timeoutMs })({ ...endpoint }, AbortSignal.timeout(timeoutMs));
          return listed.ok ? { ok: true, models: listed.models, capabilities: listed.capabilities ?? {} } : listed;
        } catch (error) {
          return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
      },
      usable: (listed) => (spec.usable ? this.now(() => spec.usable!([...listed]), `${label} usable`, () => listed) : listed),
      defaultInput: spec.defaultInput ?? [],
      capabilities: (model, listed) => (spec.capabilities ? this.now(() => spec.capabilities!(model, copy(listed)), `${label} capabilities`, () => listed) : listed),
      ...(signIn ? { signIn: { title: both(spec.signIn!.title), run: (helpers: { open(url: string): void; signal: AbortSignal }) => signIn(helpers) } } : {}),
      build: (profile) =>
        chatOf(
          this.now(() => spec.build(copy(profile)), `${label} build`, (message) => {
            throw new Error(`${both(spec.title).en} could not start ${profile.model}: ${message}`);
          })
        )
    };
  }

  /** The app's own OpenAI-compatible adapter for a plugin's provider; its `body` and `headers` run in the plugin's scope. */
  private compatible(options: CompatibleModelOptions): ChatModel {
    this.svc("models");
    const shape = options.body;
    const answer = options.responses;
    const label = `compatible model ${options.model} body`;
    const sign = options.headers ? this.back(options.headers.bind(options), `compatible model ${options.model} headers`, { ms: 30_000 }) : null;
    return new OpenAiCompatible({
      baseURL: String(options.baseURL),
      apiKey: String(options.apiKey ?? ""),
      model: String(options.model),
      inputModalities: options.inputModalities,
      outputModalities: options.outputModalities,
      webSearch: options.webSearch === "chat" ? "chat" : options.webSearch === "responses",
      ...(shape
        ? {
            body: (json: Record<string, unknown>, request: Parameters<ChatModel["chat"]>[0]) =>
              this.now(() => shape(json, copy(request)), label, (message) => {
                throw new Error(`${this.identity.id} could not shape the request: ${message}`);
              })
          }
        : {}),
      ...(answer
        ? {
            responses: (json: Record<string, unknown>, request: Parameters<ChatModel["chat"]>[0]) =>
              this.now(() => answer(json, copy(request)), `compatible model ${options.model} responses`, (message) => {
                throw new Error(`${this.identity.id} could not shape the request: ${message}`);
              })
          }
        : {}),
      ...(sign
        ? {
            headers: async (request: { url: string; body: string }) => {
              try {
                return strings(await sign({ ...request }));
              } catch (error) {
                throw new Error(`${this.identity.id} could not set the request headers: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
          }
        : {})
    });
  }

  private disposerOf(off: () => void): Disposer {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
    };
  }

  private build(): PluginContext {
    const host = this;
    const ns = this.ns;
    const logger = this.logger;
    const items = () => this.svc("items");

    const context: PluginContext = {
      id: this.identity.id,
      namespace: ns,
      dataDir: this.identity.dataDir,
      logger: { debug: (...a) => logger.debug(...(a as [string])), info: (...a) => logger.info(...(a as [string])), warn: (...a) => logger.warn(...(a as [string])), error: (...a) => logger.error(...(a as [string])) },

      get items(): ItemsApi {
        return {
          list: (filter) => host.call(() => items().list(filter ?? {})),
          query: (q) => host.call(() => items().query(q)),
          get: (projectId, id) => host.call(() => items().get(projectId, id)),
          getByKey: (projectId, key) => host.call(() => items().getByKey(projectId, key)),
          create: (input) => host.call(() => items().create({ ...input, by: authorFor(ns) })),
          update: (projectId, id, patch, opts) => host.call(() => items().update(projectId, id, patch, authorFor(ns), opts)),
          delete: (projectId, id) => host.call(() => items().delete(projectId, id, authorFor(ns))),
          addRelation: (projectId, id, blockedId) => host.call(() => items().addRelation(projectId, id, blockedId, authorFor(ns))),
          removeRelation: (projectId, id, blockedId) => host.call(() => items().removeRelation(projectId, id, blockedId, authorFor(ns))),
          labels: (projectId) => host.call(() => items().labelsFor(projectId)),
          gate: (check) =>
            host.call(() => {
              items(); // refused, like every items call, unless the plugin named "items"
              return host.disposerOf(
                host.ctx.on("write/pre-commit", (intent, next) => {
                  host.judge(check, intent);
                  return next();
                })
              );
            })
        };
      },

      get fields(): FieldsApi {
        const fields = () => host.svc("fields");
        return {
          list: (projectId) => host.call(() => fields().list(projectId)),
          get: (projectId, id) => host.call(() => fields().get(projectId, id)),
          create: (input) => host.call(() => fields().create(input)),
          update: (projectId, id, patch) => host.call(() => fields().update(projectId, id, patch)),
          remove: (projectId, id) => host.call(() => fields().remove(projectId, id)),
          addOption: (projectId, fieldId, input) => host.call(() => fields().addOption(projectId, fieldId, input))
        };
      },

      get boards(): BoardsApi {
        const boards = () => host.svc("boards");
        return {
          list: (projectId) => host.call(() => boards().list(projectId)),
          get: (projectId, id) => host.call(() => boards().get(projectId, id)),
          defaultFor: (projectId) => host.call(() => boards().defaultFor(projectId))
        };
      },

      get views(): ViewsApi {
        const views = () => host.svc("views");
        return {
          list: (projectId) => host.call(() => views().listForProject(projectId)),
          get: (projectId, id) => host.call(() => views().get(projectId, id))
        };
      },

      get projects(): ProjectsApi {
        const projects = () => host.svc("projects");
        return {
          list: () => host.call(() => projects().list()),
          get: (id) => host.call(() => projects().get(id))
        };
      },

      get db(): DbApi {
        const db = () => host.svc("db");
        const handle = (target: string) => (target === "hub" ? db().hub : db().for(target));
        return {
          migrate: (steps, opts) =>
            host.call(() => {
              db().migrate(ns, steps, opts);
            }),
          all: <T>(target: string, sql: string, params?: SqlParams) => host.call(() => handle(target).prepare(sql).all(...spread(params)) as T[]),
          get: <T>(target: string, sql: string, params?: SqlParams) => host.call(() => handle(target).prepare(sql).get(...spread(params)) as T | undefined),
          run: (target, sql, params) =>
            host.call(() => {
              const info = handle(target).prepare(sql).run(...spread(params));
              return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
            }),
          batch: (target, statements) => host.call(() => handle(target).transaction(() => statements.map((s) => ({ changes: handle(target).prepare(s.sql).run(...spread(s.params)).changes })))),
          isOpen: (projectId) => host.call(() => db().has(projectId))
        };
      },

      get settings(): SettingsApi {
        const settings = () => host.svc("settings");
        return {
          register: (section) =>
            host.call(() => {
              const id = section.id ?? ns;
              host.own(id, "settings section");
              settings().register({ id, title: section.title, description: section.description, schema: section.schema, defaults: section.defaults, scope: section.scope, agent: section.agent, order: 100, ...(section.words ? { words: section.words } : {}) });
            }),
          get: <T>(id?: string) => host.call(() => settings().get()[id ?? ns] as T),
          set: (value, id) =>
            host.call(() => {
              const key = id ?? ns;
              host.own(key, "settings section");
              settings().set({ [key]: value } as never);
            }),
          locale: () => host.call(() => host.locale()),
          show: (id) =>
            host.call(() => {
              const key = id ?? ns;
              host.own(key, "settings section");
              settings().show(key);
            })
        };
      },

      get tools(): ToolsApi {
        const tools = () => host.svc("tools");
        return {
          register: (tool) =>
            host.call(() => {
              host.own(tool.name, "tool");
              if (tool.kit) host.own(tool.kit, "tool kit");
              const execute = host.back(tool.execute, `tool ${tool.name}`);
              return host.disposerOf(
                tools().register({
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  input: tool.input,
                  kit: tool.kit,
                  execute: (args, inv) => execute(args, { projectId: inv.projectId, runId: inv.run?.id, author: inv.by })
                })
              );
            }),
          kit: (id, purpose) =>
            host.call(() => {
              host.own(id, "tool kit");
              return host.disposerOf(tools().kit(id, purpose));
            }),
          list: () => host.call(() => tools().describe()),
          call: (name, args, opts) => host.call(() => tools().execute(name, args, { by: authorFor(ns), projectId: opts?.projectId })),
          gate: (check) =>
            host.call(() => {
              const run = host.back(check, "tool gate");
              return host.disposerOf(
                host.ctx.on("tools/pre-execute", async (call, next) => {
                  // A copy: arguments change only through an `{ args }` answer, which the tool's input checks again.
                  const info: ToolCallInfo = { name: call.name, args: copy(call.args), author: call.by, projectId: call.projectId, runId: call.run?.id };
                  const answer = await run(info);
                  if (answer && typeof answer === "object") {
                    if ("result" in answer) return answer.result;
                    if ("args" in answer) call.args = answer.args;
                  }
                  return next();
                })
              );
            })
        };
      },

      get contributions(): ContributionsApi {
        const c = () => host.svc("contributions");
        return {
          command: (def) =>
            host.call(() => {
              host.own(def.id, "command");
              const run = host.back(def.run, `command ${def.id}`, { human: true, ms: COMMAND_MS });
              return host.disposerOf(c().command({ id: def.id, title: host.say(def.title), group: host.say(def.group), shortcut: def.shortcut, run: (scope) => run(scope).then((r) => r ?? undefined) }));
            }),
          badge: (def) =>
            host.call(() => {
              host.own(def.id, "badge");
              return host.disposerOf(c().badge({ id: def.id, compute: host.back(def.compute, `badge ${def.id}`, { ms: RENDER_MS }) }));
            }),
          statusItem: (def) =>
            host.call(() => {
              host.own(def.id, "status item");
              if (def.command) host.own(def.command, "status item command");
              const until = def.until ? host.back(def.until, `status item ${def.id} until`, { ms: RENDER_MS }) : undefined;
              const menu = def.menu ? host.back(def.menu, `status item ${def.id} menu`, { ms: RENDER_MS }) : undefined;
              return host.disposerOf(c().statusItem({
                id: def.id, text: host.back(def.text, `status item ${def.id}`, { ms: RENDER_MS }), title: host.say(def.title), icon: def.icon, align: def.align, command: def.command,
                ...(until ? { until } : {}),
                ...(menu ? { menu: async (scope: { projectId?: string }) => {
                  const entries = await menu(scope);
                  for (const entry of entries ?? []) host.own(entry.command, "status menu command");
                  return entries;
                } } : {})
              }));
            }),
          refresh: () =>
            host.call(() => {
              c().changed();
            }),
          section: (def) =>
            host.call(() => {
              host.own(def.id, "section");
              return host.disposerOf(c().section({ id: def.id, title: host.say(def.title), render: host.back(def.render, `section ${def.id}`, { ms: RENDER_MS }) }));
            }),
          graph: (def) =>
            host.call(() => {
              host.own(def.id, "graph");
              return host.disposerOf(c().graph({ id: def.id, title: def.title, icon: def.icon, edits: def.edits, compute: host.back(def.compute, `graph ${def.id}`, { ms: RENDER_MS }) }));
            }),
          sidebarModule: (def) =>
            host.call(() => {
              host.own(def.id, "sidebar module");
              const rows = def.rows ? host.back(def.rows, `sidebar module ${def.id}`, { ms: RENDER_MS }) : undefined;
              return host.disposerOf(c().sidebarModule({ id: def.id, title: host.say(def.title), icon: def.icon, command: def.command, ...(rows ? { rows } : {}) }));
            })
        };
      },

      get agent(): AgentApi {
        const agent = () => host.svc("agent");
        return {
          playbook: (spec) =>
            host.call(() => {
              host.own(spec.id, "playbook");
              return host.disposerOf(agent().playbook({ id: spec.id, title: spec.title, when: spec.when, body: spec.body, tools: spec.tools }));
            }),
          request: (hook) =>
            host.call(() => {
              agent(); // refused, like every agent call, unless the plugin named "agent"
              const run = host.back(hook, "request hook", { ms: HOOK_MS });
              return host.disposerOf(
                host.ctx.on("agent/request", async (request, next) => {
                  const change = await host.hooked(() => run(modelRequest(request)), "request hook");
                  if (change) Object.assign(request, changeOf(change));
                  return next();
                })
              );
            }),
          requestError: (hook) =>
            host.call(() => {
              agent();
              const run = host.back(hook, "request error hook", { ms: HOOK_MS });
              return host.disposerOf(
                host.ctx.on("agent/request-error", async (failure) => {
                  const message = failure.error instanceof Error ? failure.error.message : String(failure.error);
                  const answer = await host.hooked(() => run({ message, request: modelRequest(failure.request), attempt: failure.attempt }), "request error hook");
                  if (!answer || (!answer.request && !answer.profile)) return undefined;
                  return { ...(answer.request ? { request: changeOf(answer.request) } : {}), ...(typeof answer.profile === "string" ? { profile: answer.profile } : {}) };
                })
              );
            }),
          turnEnding: (hook) =>
            host.call(() => {
              agent();
              const run = host.back(hook, "turn ending hook", { ms: HOOK_MS });
              return host.disposerOf(
                host.ctx.on("agent/turn-stopping", async (ending) => {
                  const answer = await host.hooked(() => run(copy(ending)), "turn ending hook");
                  return typeof answer?.continue === "string" && answer.continue.trim() ? { continue: answer.continue } : undefined;
                })
              );
            }),
          cliHook: (spec) =>
            host.call(() => {
              agent();
              const events = spec.events?.length ? new Set<string>(spec.events) : null;
              const agents = spec.agents?.length ? new Set(spec.agents) : null;
              const tools = spec.tools ? new RegExp(spec.tools) : null;
              const run = host.back(spec.handle.bind(spec), "CLI hook", { ms: CLI_HOOK_MS });
              const said = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
              return host.disposerOf(
                host.ctx.on("agent/cli-hook", async (call) => {
                  if ((events && !events.has(call.event)) || (agents && !agents.has(call.agent)) || (tools && !(call.tool && tools.test(call.tool.name)))) return undefined;
                  const answer = await host.hooked(() => run(copy(call)), "CLI hook");
                  if (!answer || !call.answerable) return undefined;
                  const deny = said(answer.deny), context = said(answer.context), more = said(answer.continue);
                  return deny || context || more ? { ...(deny ? { deny } : {}), ...(context ? { context } : {}), ...(more ? { continue: more } : {}) } : undefined;
                })
              );
            })
        };
      },

      get im(): ImApi {
        return {
          register: (spec) => host.call(() => {
            host.own(spec.id, "IM adapter");
            const open = host.back(spec.open, `IM adapter ${spec.id} open`);
            return host.disposerOf(host.svc("im").register({ ...spec, open: async (id, io) => {
              const session = await open(id, io);
              return {
                deliver: host.back(session.deliver.bind(session), `IM adapter ${spec.id} deliver`),
                ...(session.download ? { download: host.back(session.download.bind(session), `IM adapter ${spec.id} download`) } : {}),
                ...(session.indicate ? { indicate: host.back(session.indicate.bind(session), `IM adapter ${spec.id} indicate`) } : {}),
                ...(session.react ? { react: host.back(session.react.bind(session), `IM adapter ${spec.id} react`) } : {}),
                ...(session.commands ? { commands: host.back(session.commands.bind(session), `IM adapter ${spec.id} commands`) } : {}),
                ...(session.stream ? { stream: {
                  start: host.back(session.stream.start.bind(session.stream), `IM adapter ${spec.id} stream start`),
                  append: host.back(session.stream.append.bind(session.stream), `IM adapter ${spec.id} stream append`),
                  stop: host.back(session.stream.stop.bind(session.stream), `IM adapter ${spec.id} stream stop`)
                } } : {}),
                ...(session.identity ? { identity: session.identity } : {}),
                close: host.back(session.close.bind(session), `IM adapter ${spec.id} close`)
              };
            } }));
          })
        };
      },

      get surfaces(): SurfacesApi {
        const surfaces = () => host.svc("surfaces");
        return {
          open: (spec) =>
            host.call(() => {
              host.own(spec.id, "surface");
              const window = spec.kind === "window";
              if (window && host.identity.origin === "extension" && !host.identity.window) throw new Error(`${host.identity.id} opens window "${spec.id}" but its manifest does not grant permissions.window`);
              const url = host.documentUrl(spec.document);
              const onMessage = spec.onMessage ? host.listen(spec.onMessage, `surface ${spec.id}`) : undefined;
              const onClose = spec.onClose ? host.listen(spec.onClose, `surface ${spec.id} close`) : undefined;
              let closed = false;
              // A call on a closed window used to go nowhere; the plugin hears of it instead.
              const live = <T>(fn: () => T) => host.call(() => {
                if (closed) throw new Error(`surface ${spec.id} is closed`);
                return fn();
              });
              const surface = surfaces().open({
                id: spec.id,
                title: window ? windowTitle(String(spec.title), host.identity.title) : spec.title,
                url,
                width: spec.width,
                height: spec.height,
                ...(window ? { kind: "window" as const, ...(spec.minWidth ? { minWidth: spec.minWidth } : {}), ...(spec.minHeight ? { minHeight: spec.minHeight } : {}) } : {}),
                transparent: spec.transparent,
                alwaysOnTop: spec.alwaysOnTop,
                focusable: spec.focusable,
                clickThrough: spec.clickThrough,
                anchor: spec.anchor,
                initialState: spec.initialState,
                onMessage: onMessage ? (m) => within(ns, () => onMessage(m as never), true) : undefined,
                onClose: () => {
                  if (closed) return;
                  closed = true;
                  onClose?.();
                }
              });
              return {
                id: surface.id,
                setState: (state: unknown) => live(() => surface.setState(state)),
                post: (message: unknown) => live(() => surface.post(message)),
                setPosition: (x: number, y: number) => live(() => surface.setPosition(x, y)),
                bounds: () => live(() => surface.bounds()),
                workArea: () => live(() => surface.workArea()),
                // Closing twice is harmless.
                close: () => host.call(() => (closed ? undefined : surface.close()))
              };
            })
        };
      },

      get alerts(): AlertsApi {
        const alerts = () => host.svc("alerts");
        return {
          sounds: () => host.call(() => alerts().sounds()),
          play: (sound, opts) => host.call(() => alerts().play(sound, opts)),
          notify: (notice) => host.call(() => alerts().notify({ title: String(notice.title), body: notice.body === undefined ? undefined : String(notice.body) }))
        };
      },

      get oplog(): OplogApi {
        const oplog = () => host.svc("oplog");
        return {
          recent: (projectId, limit) => host.call(() => oplog().recent(projectId, limit)),
          history: (projectId, entity, id, limit) => host.call(() => oplog().historyFor(projectId, entity, id, limit))
        };
      },

      get webSearch(): WebSearchApi {
        return {
          register: (spec) =>
            host.call(() => {
              host.own(spec.id, "web search provider");
              const label = `web search provider ${spec.id}`;
              const search = host.back(spec.search.bind(spec), `${label} search`);
              const read = spec.read ? host.back(spec.read.bind(spec), `${label} read`) : null;
              return host.disposerOf(
                host.svc("webSearch").register({
                  id: spec.id,
                  title: spec.title,
                  ...(spec.settings ? { settings: spec.settings } : {}),
                  unavailable: () => host.now(() => spec.unavailable(), `${label} unavailable`, (message) => `${spec.title} could not say whether it is set up: ${message}`),
                  search: (request, signal) => search(request, signal),
                  ...(read ? { read: (request, signal) => read(request, signal) } : {})
                })
              );
            })
        };
      },

      get models(): ModelsApi {
        return {
          registerProvider: (spec) =>
            host.call(() => {
              host.own(spec.id, "model provider");
              for (const preset of spec.presets ?? []) host.own(preset.id, "model preset");
              return host.disposerOf(host.svc("models").registerProvider(host.modelProvider(spec)));
            }),
          compatible: (options) => host.compatible(options),
          listCompatible: (endpoint, signal) =>
            host.call(async () => {
              host.svc("models");
              const listed = await listModels({ provider: "openai-compatible", baseURL: String(endpoint.baseURL) }, String(endpoint.apiKey ?? ""), 15_000, signal, endpoint.headers ? strings(endpoint.headers) : undefined);
              return listed.ok ? { ok: true as const, models: listed.models, capabilities: listed.capabilities } : listed;
            })
        };
      },

      get terminals(): TerminalsApi {
        const herdr = () => host.svc("terminals");
        return {
          state: () => host.call(() => herdr().bridge()),
          open: (paneId, opts) =>
            host.call(async () => {
              const stream = await herdr().terminal(String(paneId), { mode: opts.mode === "observe" ? "observe" : "control", cols: Number(opts.cols), rows: Number(opts.rows) });
              // One the plugin leaves open goes with it.
              const release = host.ctx.effect(() => () => stream.close(), `terminal ${stream.paneId}`);
              stream.onClose(() => release());
              const label = `terminal ${stream.paneId}`;
              return {
                paneId: stream.paneId,
                mode: stream.mode,
                onFrame: (listener) => host.disposerOf(stream.onFrame(host.listen(listener, `${label} frame`))),
                onClose: (listener) => host.disposerOf(stream.onClose(host.listen(listener, `${label} close`))),
                input: (data) => stream.input(data),
                resize: (cols, rows) => stream.resize(cols, rows),
                scroll: (scroll) => stream.scroll(scroll),
                mouse: (mouse) => stream.mouse(mouse),
                close: () => stream.close()
              };
            })
        };
      },

      on: (event, listener) => host.on(event, listener),

      when: (name, fn) => {
        if (!host.allowed.has(name)) throw new Error(`${host.identity.id} did not name "${name}" in optional`);
        const fiber = host.ctx.inject([CORDIS[name]], (inner) => {
          const sub = new Host(inner, host.identity, host.allowed);
          let dispose: Disposer | void;
          let gone = false;
          within(ns, () => fn(sub.context)).then(
            (d) => {
              if (gone) d?.();
              else dispose = d;
            },
            (error: unknown) => logger.warn(`when(${name}): ${error instanceof Error ? error.message : String(error)}`)
          );
          return () => {
            gone = true;
            dispose?.();
          };
        });
        return host.disposerOf(() => void fiber.dispose());
      },

      has: (name) => host.allowed.has(name) && host.ctx.get(CORDIS[name]) !== undefined,

      effect: (fn) => {
        host.ctx.effect(() => {
          let dispose: Disposer | undefined;
          let gone = false;
          within(ns, fn).then(
            (d) => {
              if (gone) d();
              else dispose = d;
            },
            (error: unknown) => logger.warn(`effect: ${error instanceof Error ? error.message : String(error)}`)
          );
          return () => {
            gone = true;
            dispose?.();
          };
        }, `${ns}.effect`);
      },

      interval: (fn, ms) => {
        const tick = host.listen(fn, "interval");
        return host.disposerOf(
          host.ctx.effect(() => {
            const timer = setInterval(tick, Math.max(ms, 1_000));
            return () => clearInterval(timer);
          }, `${ns}.interval`)
        );
      }
    };
    return context;
  }

  private on<K extends keyof Events>(event: K, listener: Events[K]): Disposer {
    const fire = this.listen(listener as Fn, `on(${event})`);
    const off = (() => {
      switch (event) {
        case "write":
          return this.ctx.on("write/committed", (intent: WriteIntent) =>
            fire({ projectId: intent.projectId, entity: intent.entity, op: intent.op, id: intent.id, by: intent.by, via: intent.via ?? null, runId: intent.runId ?? null } as never)
          );
        case "tool.result":
          return this.ctx.on("tools/result", (call, outcome) =>
            fire(
              { name: call.name, args: call.args, author: call.by, projectId: call.projectId, runId: call.run?.id } as never,
              (outcome.ok ? { ok: true } : { ok: false, error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) }) as never
            )
          );
        case "project.opened":
          return this.ctx.on("db/opened", (projectId: string) => fire(projectId as never));
        case "project.closed":
          return this.ctx.on("db/closed", (projectId: string) => fire(projectId as never));
        case "settings.changed":
          return this.ctx.on("settings/changed", () => fire());
        default:
          throw new Error(`unknown event "${String(event)}"`);
      }
    })();
    return this.disposerOf(off);
  }

  /** Only a file inside the plugin's own package may be shown in a surface. */
  private documentUrl(document: string): string {
    const root = this.identity.root;
    if (!root) throw new Error(`${this.identity.id} has no package directory to open "${document}" from`);
    if (/^[a-z][a-z0-9+.-]*:/i.test(document)) throw new Error(`surface documents must be files inside the plugin, not "${document}"`);
    const file = path.resolve(root, document);
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`surface document "${document}" is outside the plugin`);
    if (!fs.existsSync(file)) throw new Error(`surface document "${document}" does not exist`);
    return pathToFileURL(file).href;
  }
}
