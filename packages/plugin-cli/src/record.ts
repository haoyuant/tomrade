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
  /** Which IM contract each adapter is written against, from the capabilities it declares. */
  imContracts: { id: string; contract: "0.2.2" | "0.2.5"; capabilities: string[]; invalid?: string }[];
  /** Ids that do not carry the namespace. */
  violations: { kind: string; id: string }[];
  /** Why the dry run stopped early, if it did. */
  stopped: string | null;
}

export const emptyRecording = (): Recording => ({ tools: [], commands: [], badges: [], statusItems: [], sections: [], graphs: [], sidebarModules: [], playbooks: [], settings: [], surfaces: [], tables: [], imAdapters: [], imContracts: [], violations: [], stopped: null });

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
        labels: async () => []
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
      return need("tools", { register: (tool) => note("tools", tool.name, "tool"), list: async () => [], call: refuse, gate: async () => noop });
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
      return need("agent", { playbook: (spec) => note("playbooks", spec.id, "playbook") });
    },
    get im(): ImApi {
      return need("im", {
        register: (spec) => {
          const caps = (spec.capabilities ?? {}) as unknown as Record<string, unknown>;
          const declared = IM_CAPABILITIES_V2.filter((k) => caps[k] !== undefined);
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
    on: () => noop,
    when: () => noop,
    has: () => false,
    effect: noop,
    interval: () => noop
  };
}
