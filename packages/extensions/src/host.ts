import type { Context } from "cordis";
import type { Words } from "@tomradex/contributions";
import { extensionScope } from "@tomradex/write";
import { assertOwned, wordsFor, type Disposer, type Locale, type Localized, type PluginContext, type ServiceName } from "@tomradex/plugin-sdk";
import { agentApi } from "./facade/agent.js";
import { alertsApi } from "./facade/alerts.js";
import { boardsApi } from "./facade/boards.js";
import { contributionsApi } from "./facade/contributions.js";
import { dbApi } from "./facade/db.js";
import { fieldsApi } from "./facade/fields.js";
import { imApi } from "./facade/im.js";
import { itemsApi } from "./facade/items.js";
import { lifecycle } from "./facade/lifecycle.js";
import { modelsApi } from "./facade/models.js";
import { oplogApi } from "./facade/oplog.js";
import { projectsApi } from "./facade/projects.js";
import { settingsApi } from "./facade/settings.js";
import type { Facade, Fn } from "./facade/shared.js";
import { surfacesApi } from "./facade/surfaces.js";
import { terminalsApi } from "./facade/terminals.js";
import { toolsApi } from "./facade/tools.js";
import { viewsApi } from "./facade/views.js";
import { webSearchApi } from "./facade/web-search.js";
import { scopeFor, within, withTimeout } from "./scope.js";
import { CORDIS, type Services } from "./services.js";
import { errorMessage } from "@tomradex/contracts";

export { CLI_HOOK_MS, COMMAND_MS, HOOK_MS, RENDER_MS } from "./facade/shared.js";
export { windowTitle } from "./facade/surfaces.js";
export { cordisName } from "./services.js";

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
  /** Its manifest grants `permissions.renderer`: a layout may run inside Tomrade's window. */
  renderer?: boolean;
}

/**
 * One plugin's view of the app. It hands out nothing live: every method is a
 * call made inside the plugin's scope and answered with a Promise, every
 * function the plugin registers is called back inside that scope, and every
 * id it registers is checked against its namespace. Each API is built in
 * `./facade/` from the helpers below.
 */
export class Host {
  readonly context: PluginContext;

  constructor(
    readonly ctx: Context,
    readonly identity: ExtensionIdentity,
    readonly allowed: ReadonlySet<ServiceName>
  ) {
    this.context = this.build();
  }

  get ns(): string {
    return this.identity.namespace;
  }

  /** The same plugin's view over another context, as `when` hands one out. */
  over(ctx: Context): Host {
    return new Host(ctx, this.identity, this.allowed);
  }

  own(id: string, kind: string): void {
    if (this.identity.origin === "extension") assertOwned(this.ns, id, kind);
  }

  /** The app's language; English where settings are not loaded. */
  locale(): Locale {
    return (this.ctx.get("settings") as Context["settings"] | undefined)?.locale() ?? "en";
  }

  /** Per-language text becomes words the core reads each time it shows them, so a switch shows at once. */
  say<W extends Localized | undefined>(w: W): W extends undefined ? undefined : Words {
    return (w === undefined || typeof w === "string" ? w : () => wordsFor(this.locale(), w)) as never;
  }

  svc<K extends ServiceName>(name: K): Services[K] {
    if (!this.allowed.has(name)) throw new Error(`${this.identity.id} did not name "${name}" in inject or optional`);
    const value = this.ctx.get(CORDIS[name]);
    if (value === undefined) throw new Error(`${this.identity.id}: "${name}" is not available right now`);
    return value as never;
  }

  call<T>(fn: () => T): Promise<Awaited<T>> {
    return within(this.ns, fn);
  }

  /** Wraps a function the plugin gave the host so the host can call it back safely. */
  back<F extends Fn>(fn: F, label: string, opts: { human?: boolean; ms?: number | null } = {}) {
    return (...args: Parameters<F>): Promise<Awaited<ReturnType<F>>> =>
      withTimeout(within(this.ns, () => fn(...args) as ReturnType<F>, opts.human ?? false), opts.ms ?? null, `${this.identity.id} ${label}`);
  }

  /** A callback the host must answer at once (the core asks it synchronously): run in the plugin's scope, a throw read as `failed`. */
  now<T>(fn: () => T, label: string, failed: (message: string) => T): T {
    try {
      return extensionScope.run(scopeFor(this.ns), fn);
    } catch (error) {
      const message = errorMessage(error);
      this.logger.warn(`${this.identity.id} ${label}: ${message}`);
      return failed(message);
    }
  }

  /** Fire-and-forget: a listener that throws is logged, never propagated into the host's emit. */
  listen<F extends Fn>(fn: F, label: string) {
    const wrapped = this.back(fn, label);
    return (...args: Parameters<F>) => {
      wrapped(...args).catch((error: unknown) => this.logger.warn(`${label}: ${errorMessage(error)}`));
    };
  }

  get logger() {
    return this.ctx.logger(this.identity.id);
  }

  disposerOf(off: () => void): Disposer {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      off();
    };
  }

  private build(): PluginContext {
    const ns = this.ns;
    const logger = this.logger;
    const facade: Facade = { host: this, ns, logger };

    const context: PluginContext = {
      id: this.identity.id,
      namespace: ns,
      dataDir: this.identity.dataDir,
      logger: { debug: (...a) => logger.debug(...(a as [string])), info: (...a) => logger.info(...(a as [string])), warn: (...a) => logger.warn(...(a as [string])), error: (...a) => logger.error(...(a as [string])) },

      get items() {
        return itemsApi(facade);
      },
      get fields() {
        return fieldsApi(facade);
      },
      get boards() {
        return boardsApi(facade);
      },
      get views() {
        return viewsApi(facade);
      },
      get projects() {
        return projectsApi(facade);
      },
      get db() {
        return dbApi(facade);
      },
      get settings() {
        return settingsApi(facade);
      },
      get tools() {
        return toolsApi(facade);
      },
      get contributions() {
        return contributionsApi(facade);
      },
      get agent() {
        return agentApi(facade);
      },
      get im() {
        return imApi(facade);
      },
      get surfaces() {
        return surfacesApi(facade);
      },
      get alerts() {
        return alertsApi(facade);
      },
      get oplog() {
        return oplogApi(facade);
      },
      get webSearch() {
        return webSearchApi(facade);
      },
      get models() {
        return modelsApi(facade);
      },
      get terminals() {
        return terminalsApi(facade);
      },

      ...lifecycle(facade)
    };
    return context;
  }
}
