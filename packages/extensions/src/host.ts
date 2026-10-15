import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type {} from "@tomradex/im";
import type {} from "@tomradex/boards";
import type { Words } from "@tomradex/contributions";
import type {} from "@tomradex/db";
import type {} from "@tomradex/desktop-surface";
import type {} from "@tomradex/fields";
import type {} from "@tomradex/items";
import type {} from "@tomradex/oplog";
import type {} from "@tomradex/projects";
import type {} from "@tomradex/settings";
import type {} from "@tomradex/tools";
import type { WriteIntent } from "@tomradex/write";
import {
  assertOwned,
  type AgentApi,
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
  type OplogApi,
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
import { authorFor, within, withTimeout } from "./scope.js";

export interface ExtensionIdentity {
  /** `publisher/name` for an extension, the row id for a built-in. */
  id: string;
  namespace: string;
  /** An extension came from outside the app and is held to its namespace. */
  origin: "builtin" | "extension";
  /** Where the plugin's own files are: surface documents resolve against it. */
  root: string | null;
  dataDir: string | null;
}

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
  oplog: "oplog"
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
  oplog: Context["oplog"];
}

/** A render callback has this long before its contribution is dropped for the refresh. */
export const RENDER_MS = 2_000;
export const COMMAND_MS = 60_000;

type Fn = (...args: never[]) => unknown;

const spread = (params: SqlParams | undefined): unknown[] => (params === undefined ? [] : Array.isArray(params) ? params : [params]);

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
    return (w === undefined || typeof w === "string" ? w : () => w[this.locale()] ?? w.en) as never;
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
          labels: (projectId) => host.call(() => items().labelsFor(projectId))
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
              const execute = host.back(tool.execute, `tool ${tool.name}`);
              return host.disposerOf(
                tools().register({
                  name: tool.name,
                  title: tool.title,
                  description: tool.description,
                  input: tool.input,
                  execute: (args, inv) => execute(args, { projectId: inv.projectId, runId: inv.run?.id, author: inv.by })
                })
              );
            }),
          list: () => host.call(() => tools().describe()),
          call: (name, args, opts) => host.call(() => tools().execute(name, args, { by: authorFor(ns), projectId: opts?.projectId })),
          gate: (check) =>
            host.call(() => {
              const run = host.back(check, "tool gate");
              return host.disposerOf(
                host.ctx.on("tools/pre-execute", async (call, next) => {
                  const info: ToolCallInfo = { name: call.name, args: call.args, author: call.by, projectId: call.projectId, runId: call.run?.id };
                  await run(info);
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
              const url = host.documentUrl(spec.document);
              const onMessage = spec.onMessage ? host.listen(spec.onMessage, `surface ${spec.id}`) : undefined;
              const surface = surfaces().open({
                id: spec.id,
                title: spec.title,
                url,
                width: spec.width,
                height: spec.height,
                transparent: spec.transparent,
                alwaysOnTop: spec.alwaysOnTop,
                focusable: spec.focusable,
                clickThrough: spec.clickThrough,
                anchor: spec.anchor,
                initialState: spec.initialState,
                onMessage: onMessage ? (m) => within(ns, () => onMessage(m as never), true) : undefined
              });
              return {
                id: surface.id,
                setState: (state: unknown) => host.call(() => surface.setState(state)),
                setPosition: (x: number, y: number) => host.call(() => surface.setPosition(x, y)),
                bounds: () => host.call(() => surface.bounds()),
                workArea: () => host.call(() => surface.workArea()),
                close: () => host.call(() => surface.close())
              };
            })
        };
      },

      get oplog(): OplogApi {
        const oplog = () => host.svc("oplog");
        return {
          recent: (projectId, limit) => host.call(() => oplog().recent(projectId, limit)),
          history: (projectId, entity, id, limit) => host.call(() => oplog().historyFor(projectId, entity, id, limit))
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
