import {
  IM_CAPABILITIES_V2,
  ImCapabilitiesSchema,
  ownsId,
  type AgentApi,
  type ImApi,
  type BoardsApi,
  type ContributionsApi,
  type DbApi,
  type FieldsApi,
  type ItemsApi,
  type AlertsApi,
  type OplogApi,
  type TerminalsApi,
  type WebSearchApi,
  type PluginContext,
  type ProjectsApi,
  type ServiceName,
  type SettingsApi,
  type SurfacesApi,
  type ToolsApi,
  type ViewsApi
} from "@tomradex/plugin-sdk";

/** What a plugin registers when it is applied with nothing real behind it. */
export interface Recording {
  tools: string[];
  commands: string[];
  badges: string[];
  statusItems: string[];
  sections: string[];
  graphs: string[];
  sidebarModules: string[];
  playbooks: string[];
  settings: string[];
  surfaces: string[];
  tables: string[];
  imAdapters: string[];
  webSearchProviders: string[];
  /** Which IM contract each adapter is written against, from the capabilities it declares. */
  imContracts: { id: string; contract: "0.2.2" | "0.2.5"; capabilities: string[]; invalid?: string }[];
  /** Ids that do not carry the namespace. */
  violations: { kind: string; id: string }[];
  /** Why the dry run stopped early, if it did. */
  stopped: string | null;
}

export const emptyRecording = (): Recording => ({ tools: [], commands: [], badges: [], statusItems: [], sections: [], graphs: [], sidebarModules: [], playbooks: [], settings: [], surfaces: [], tables: [], imAdapters: [], webSearchProviders: [], imContracts: [], violations: [], stopped: null });

const noop = () => {};
const DRY = "dry run: nothing is written while a plugin is inspected";

/**
 * A PluginContext that answers every read with nothing, refuses every write,
 * and writes down every id registered — enough to learn what a plugin
 * contributes without giving it anything to act on.
 */
export function recordingContext(namespace: string, allowed: ServiceName[], rec: Recording): PluginContext {
  const settings = new Map<string, unknown>();
  const note = (kind: keyof Omit<Recording, "violations" | "stopped" | "imContracts">, id: string, label: string) => {
    rec[kind].push(id);
    if (!ownsId(namespace, id)) rec.violations.push({ kind: label, id });
    return Promise.resolve(noop);
  };
  const refuse = () => Promise.reject(new Error(DRY));
  const need = <T>(name: ServiceName, api: T): T => {
    if (!allowed.includes(name)) throw new Error(`the plugin did not name "${name}" in inject or optional`);
    return api;
  };
  return {
    id: `inspect/${namespace}`,
    namespace,
    dataDir: null,
    logger: { debug: noop, info: noop, warn: noop, error: noop },
    get items(): ItemsApi {
      return need("items", {
        list: async () => [],
        query: async () => [],
        get: async () => null,
        getByKey: async () => null,
        create: refuse,
        update: refuse,
        delete: refuse,
        addRelation: refuse,
        removeRelation: refuse,
        labels: async () => [],
        gate: async () => noop
      });
    },
    get fields(): FieldsApi {
      return need("fields", { list: async () => [], get: async () => null, create: refuse, update: refuse, remove: refuse, addOption: refuse });
    },
    get boards(): BoardsApi {
      return need("boards", { list: async () => [], get: async () => null, defaultFor: refuse });
    },
    get views(): ViewsApi {
      return need("views", { list: async () => [], get: async () => null });
    },
    get projects(): ProjectsApi {
      return need("projects", { list: async () => [], get: async () => null });
    },
    get db(): DbApi {
      return need("db", {
        migrate: async (_steps, opts) => {
          for (const table of Object.keys(opts.tables)) rec.tables.push(table);
        },
        all: async () => [],
        get: async () => undefined,
        run: refuse,
        batch: refuse,
        isOpen: async () => false
      });
    },
    get settings(): SettingsApi {
      return need("settings", {
        register: async (section) => {
          const id = section.id ?? namespace;
          settings.set(id, section.defaults);
          await note("settings", id, "settings section");
        },
        get: async <T>(id?: string) => settings.get(id ?? namespace) as T,
        set: refuse,
        show: async () => {},
        locale: async () => "en" as const
      });
    },
    get tools(): ToolsApi {
      return need("tools", {
        register: (tool) => {
          if (tool.kit && !ownsId(namespace, tool.kit)) rec.violations.push({ kind: "tool kit", id: tool.kit });
          return note("tools", tool.name, "tool");
        },
        kit: async (id) => {
          if (!ownsId(namespace, id)) rec.violations.push({ kind: "tool kit", id });
          return noop;
        },
        list: async () => [],
        call: refuse,
        gate: async () => noop
      });
    },
    get contributions(): ContributionsApi {
      return need("contributions", {
        command: (def) => note("commands", def.id, "command"),
        badge: (def) => note("badges", def.id, "badge"),
        statusItem: (def) => note("statusItems", def.id, "status item"),
        section: (def) => note("sections", def.id, "section"),
        graph: (def) => note("graphs", def.id, "graph"),
        sidebarModule: (def) => note("sidebarModules", def.id, "sidebar module"),
        refresh: async () => {}
      });
    },
    get agent(): AgentApi {
      return need("agent", { playbook: (spec) => note("playbooks", spec.id, "playbook"), request: async () => noop, requestError: async () => noop, turnEnding: async () => noop });
    },
    get im(): ImApi {
      return need("im", {
        register: (spec) => {
          const caps = (spec.capabilities ?? {}) as unknown as Record<string, unknown>;
          const declared: string[] = IM_CAPABILITIES_V2.filter((k) => caps[k] !== undefined);
          // A host before 0.2.5 never asks for the credentials `setup` describes.
          if (spec.setup) declared.push("setup");
          const parsed = ImCapabilitiesSchema.safeParse(spec.capabilities);
          rec.imContracts.push({ id: spec.id, contract: declared.length ? "0.2.5" : "0.2.2", capabilities: [...declared],
            ...(parsed.success ? {} : { invalid: parsed.error.issues.map((i) => `${i.path.join(".") || "capabilities"}: ${i.message}`).join("; ") }) });
          return note("imAdapters", spec.id, "IM adapter");
        }
      });
    },
    get surfaces(): SurfacesApi {
      return need("surfaces", {
        open: async (spec) => {
          await note("surfaces", spec.id, "surface");
          return refuse();
        }
      });
    },
    get alerts(): AlertsApi {
      return need("alerts", { sounds: async () => [], play: async () => {}, notify: async () => {} });
    },
    get oplog(): OplogApi {
      return need("oplog", { recent: async () => [], history: async () => [] });
    },
    get webSearch(): WebSearchApi {
      return need("webSearch", { register: (provider) => note("webSearchProviders", provider.id, "web search provider") });
    },
    get terminals(): TerminalsApi {
      return need("terminals", {
        state: async () => ({ state: "notInstalled" as const }),
        open: async () => {
          throw new Error("no terminals in a dry run");
        }
      });
    },
    on: () => noop,
    when: () => noop,
    has: () => false,
    effect: noop,
    interval: () => noop
  };
}
