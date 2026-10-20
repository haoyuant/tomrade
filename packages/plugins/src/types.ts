import type { Plugin } from "cordis";
import type { ExtensionInfo, ExtensionStore } from "./extensions.js";

/** One row of the composition: exactly what a line of tomrade.yml carries. */
export interface PluginRow {
  id: string;
  name: string;
  /** What to call the row where the plugin cannot say itself — switched off, it registers no title. */
  title?: string;
  config?: unknown;
  disabled?: boolean;
  /** Contract ids this row fills, for when it is switched off and registers nothing to observe. */
  implements?: string[];
  /** The full-mode extension whose rows put this row's plugin here: its writes carry that extension's namespace. */
  from?: string;
}

/** A row as a patch file or a full-mode extension writes it: the fields it changes on the row with its id. */
export type RowPatch = Partial<PluginRow> & { id: string };

/**
 * Rows no extension's rows may change: the renderer's channels, through which a
 * plugin is switched off and removed, and the catalog that verifies and revokes
 * plugins. Protecting Tomrade itself is the one limit full mode has.
 */
export const PROTECTED_ROWS: ReadonlySet<string> = new Set(["ipc", "community"]);

/**
 * A module is a capability, named by the service key that carries it. A
 * required module may never be left without a plugin providing it — that is
 * the one thing the manager refuses.
 */
export interface ModuleSpec {
  id: string;
  title: string;
  required?: boolean;
}

/**
 * A contract is a registry plugins plug into, named by the call that does it —
 * `agent.engine`, `storage.register`. Its members are interchangeable, which
 * is what the Plugins pane groups them by.
 */
export interface ContractSpec {
  id: string;
  title: string;
  /** The registering call. Its effects on a running row are how membership is observed. */
  registry: string;
}

export type PluginState = "active" | "failed" | "pending" | "disabled";

/** What the renderer, and `--dump-config`, get for one row. */
export interface PluginView {
  id: string;
  name: string;
  title?: string;
  config?: unknown;
  state: PluginState;
  error?: string;
  /** For a pending row: the services it is still waiting for. */
  waitingFor?: string[];
  /** Service keys this row puts on the context — observed, not declared. */
  provides: string[];
  /** Service keys it named in `inject`. Empty until it has loaded once. */
  injects: string[];
  /** Required modules it is the only provider of, which is why it cannot be switched off. */
  holds: string[];
  /** Contracts it fills: declared on its row, plus any it was seen registering into. */
  implements: string[];
  /** Present when the row is an installed extension rather than part of the app. */
  extension?: ExtensionInfo;
  /** A full-mode extension's rows taken back this start, and the required modules they left with no plugin. */
  rowsRefused?: string[];
}

export interface ModuleView {
  id: string;
  title: string;
  required: boolean;
  /** Plugin ids currently providing it. Empty means the module is unfilled. */
  providers: string[];
}

export interface PluginsSnapshot {
  modules: ModuleView[];
  contracts: ContractSpec[];
  plugins: PluginView[];
  /** Records of compatibility.json that could not be read, which no exemption comes from. */
  compatibilityProblems?: string[];
}

export interface PluginsConfig {
  rows: PluginRow[];
  modules?: ModuleSpec[];
  contracts?: ContractSpec[];
  /**
   * Turning a name into a plugin belongs to the host: Node resolves a bare
   * package specifier against the file that asks for it, and the application
   * is what depends on the plugins.
   */
  resolve(row: PluginRow): Promise<Plugin>;
  /** Installed extensions; their rows join the composition's. */
  extensions?: ExtensionStore;
  /** Called after a row is switched, so the choice survives a restart. */
  persist?(id: string, disabled: boolean): void | Promise<void>;
  /**
   * The composition again, without the rows of the full-mode extensions named:
   * how a start takes back rows that left a required module empty.
   */
  recompose?(without: ReadonlySet<string>): PluginRow[];
  /** The full-mode extensions whose rows this start applied, in the order they were laid on. */
  rowsFrom?: string[];
  /** The person's switches for rows the composition no longer has, by row id: what a plugin taking such a row's place starts as. */
  leftSwitches?: Record<string, boolean>;
}

/** Refusing to empty a required module is the guard; it reads as one sentence. */
export class RequiredModuleError extends Error {
  override name = "RequiredModuleError";

  constructor(
    public readonly pluginId: string,
    public readonly modules: ModuleView[]
  ) {
    const titles = modules.map((m) => m.title);
    const list = titles.length > 1 ? `${titles.slice(0, -1).join(", ")} and ${titles.at(-1)}` : titles[0];
    super(`Switching off “${pluginId}” would leave ${list} with no plugin. Add another provider first.`);
  }
}
