import { Context, Service, type EffectMeta, type Fiber } from "cordis";
import type {} from "@tomradex/ipc";
import type { Manifest } from "@tomradex/plugin-sdk";
import { ExtensionRefused } from "./extensions.js";
import {
  RequiredModuleError,
  type ModuleView,
  type PluginRow,
  type PluginState,
  type PluginView,
  type PluginsConfig,
  type PluginsSnapshot
} from "./types.js";

declare module "cordis" {
  interface Context {
    plugins: Plugins;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "plugins.list": () => PluginsSnapshot;
    "plugins.setEnabled": (id: string, enabled: boolean) => PluginsSnapshot;
    /** A `.tomrade-plugin` file a person picked. */
    "plugins.installFile": (file: string) => PluginsSnapshot;
    /** A plugin's own folder, loaded as it stands and reloaded when its build changes. */
    "plugins.addFolder": (dir: string) => PluginsSnapshot;
    "plugins.uninstall": (id: string, removeData: boolean) => PluginsSnapshot;
    "plugins.rollback": (id: string) => PluginsSnapshot;
    "plugins.reload": (id: string) => PluginsSnapshot;
    /** Allow a development build to load at exactly this digest. */
    "plugins.confirm": (id: string, digest: string) => PluginsSnapshot;
    "plugins.setAutoUpdate": (id: string, on: boolean) => PluginsSnapshot;
    /** Run this exact plugin version on this exact Tomrade anyway, outside the ranges it names; the person accepted the risk. */
    "plugins.allowVersion": (id: string) => PluginsSnapshot;
    "plugins.withdrawVersion": (id: string) => PluginsSnapshot;
  }
  interface Broadcasts {
    "plugins.changed": () => void;
  }
}

const STATE: Record<number, PluginState> = { 0: "pending", 1: "pending", 2: "active", 3: "failed", 4: "failed", 5: "pending" };

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The shape cordis records for a live service: which fiber put it there. */
interface Impl {
  name: string;
  fiber: Fiber;
}

/**
 * The loader, and the thing the user manages it with. It owns every row's
 * fiber, so it can say what is running, switch a row off, and put it back —
 * except when that would leave a required module with nothing providing it.
 *
 * It is not a row itself: you cannot switch off the thing that does the switching.
 */
export class Plugins extends Service {
  static provide = "plugins";

  private fibers = new Map<string, Fiber>();
  private errors = new Map<string, unknown>();
  /** Full-mode extensions whose rows this start took back, and the required modules those rows left empty. */
  private rowsRefused = new Map<string, string[]>();
  private notify: () => void = () => {};
  private queue: Promise<void> = Promise.resolve();
  /**
   * Inside a service method `this.ctx` is the *caller's* context, and a row
   * loaded from one would belong to whoever asked for it — the IPC handler, on
   * a switch thrown in the UI. Every row hangs off this one instead.
   */
  private readonly home: Context;

  constructor(
    ctx: Context,
    public readonly config: PluginsConfig
  ) {
    super(ctx, "plugins");
    this.home = ctx;
    const store = config.extensions;
    if (store) {
      const taken = new Set(config.rows.map((r) => r.id));
      for (const row of store.rows()) if (!taken.has(row.id)) config.rows.push({ ...row });
      store.onChange = (id) => void this.reload(id).catch((error: unknown) => this.home.logger.warn(`${id}: ${messageOf(error)}`));
    }
  }

  get extensions() {
    return this.config.extensions;
  }

  async [Service.init]() {
    for (const row of this.config.rows) {
      if (!row.disabled) await this.start(row);
    }
    await this.settle();
    await this.keepRequired();

    for (const view of this.list()) {
      if (view.state === "pending") this.home.logger.warn(`${view.id} is waiting for: ${view.waitingFor?.join(", ") ?? "?"}`);
    }
    for (const module of this.modules()) {
      if (module.required && !module.providers.length) this.home.logger.warn(`nothing provides the required module "${module.id}"`);
    }

    this.config.extensions?.watchAll();

    this.home.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("plugins.list", () => ctx.plugins.snapshot());
      ctx.ipc.handle("plugins.setEnabled", (id, enabled) => ctx.plugins.setEnabled(id, enabled));
      ctx.ipc.handle("plugins.installFile", (file) => ctx.plugins.installFile(file));
      ctx.ipc.handle("plugins.addFolder", (dir) => ctx.plugins.addFolder(dir));
      ctx.ipc.handle("plugins.uninstall", (id, removeData) => ctx.plugins.uninstall(id, { removeData }));
      ctx.ipc.handle("plugins.rollback", (id) => ctx.plugins.rollback(id));
      ctx.ipc.handle("plugins.reload", (id) => ctx.plugins.reload(id));
      ctx.ipc.handle("plugins.confirm", (id, digest) => ctx.plugins.confirm(id, digest));
      ctx.ipc.handle("plugins.allowVersion", (id) => ctx.plugins.allowVersion(id));
      ctx.ipc.handle("plugins.withdrawVersion", (id) => ctx.plugins.withdrawVersion(id));
      ctx.ipc.handle("plugins.setAutoUpdate", (id, on) => {
        this.store().setAutoUpdate(id, on);
        this.notify();
        return ctx.plugins.snapshot();
      });
      this.notify = () => ctx.ipc.send("plugins.changed");
      return () => {
        this.notify = () => {};
      };
    });
  }

  rows(): PluginRow[] {
    return this.config.rows;
  }

  /** Whether a row is switched off, a row the app no longer ships included: the person's switch for it outlives the row. */
  switchedOff(id: string): boolean {
    const row = this.config.rows.find((r) => r.id === id);
    return row ? !!row.disabled : this.config.leftSwitches?.[id] === true;
  }

  snapshot(): PluginsSnapshot {
    const problems = this.config.extensions?.compatibilityProblems ?? [];
    return { modules: this.modules(), contracts: this.config.contracts ?? [], plugins: this.list(), ...(problems.length ? { compatibilityProblems: problems } : {}) };
  }

  list(): PluginView[] {
    const provided = this.providers();
    const held = this.soleProviders(provided);
    const owns = new Map<string, string[]>();
    for (const [name, ids] of provided) {
      for (const id of ids) owns.set(id, [...(owns.get(id) ?? []), name]);
    }
    return this.config.rows.map((row) => this.describe(row, owns.get(row.id) ?? [], held.get(row.id) ?? []));
  }

  modules(): ModuleView[] {
    const provided = this.providers();
    return (this.config.modules ?? []).map((module) => ({
      id: module.id,
      title: module.title,
      required: module.required === true,
      providers: provided.get(module.id) ?? []
    }));
  }

  /**
   * Switching a row on loads it; switching one off disposes its fiber, and
   * everything that injected what it provided unloads with it. Both survive a
   * restart through `persist`.
   *
   * Switches run one at a time. Two of them interleaved would read a half
   * torn-down context and guard against the wrong answer — and two windows, or
   * one impatient click, are enough to do it.
   */
  setEnabled(id: string, enabled: boolean): Promise<PluginsSnapshot> {
    const next = this.queue.then(() => this.apply(id, enabled));
    // The queue itself must never carry a rejection forward: a refused switch
    // is this caller's to see, not the next one's.
    this.queue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  /** Serialised with the switches, for the same reason they are. */
  private queued<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  private store() {
    const store = this.config.extensions;
    if (!store) throw new Error("This build has no extension store");
    return store;
  }

  /** A row that joins after boot: an extension installed, or a folder loaded. */
  add(row: PluginRow): Promise<PluginsSnapshot> {
    return this.queued(async () => {
      if (this.config.rows.some((r) => r.id === row.id)) return this.restart(row.id);
      this.config.rows.push({ ...row });
      if (!row.disabled) {
        await this.start(this.config.rows.at(-1)!);
        await this.settle();
      }
      this.notify();
      return this.snapshot();
    });
  }

  /** Unload a row and forget it. Held modules are guarded as for a switch. */
  remove(id: string): Promise<PluginsSnapshot> {
    return this.queued(async () => {
      const row = this.config.rows.find((r) => r.id === id);
      if (!row) return this.snapshot();
      if (!row.disabled) await this.disable(row);
      this.config.rows = this.config.rows.filter((r) => r.id !== id);
      this.notify();
      return this.snapshot();
    });
  }

  /** Load a row again from its current files; a switched-off row stays off. */
  reload(id: string): Promise<PluginsSnapshot> {
    return this.queued(() => this.restart(id));
  }

  private async restart(id: string): Promise<PluginsSnapshot> {
    const row = this.config.rows.find((r) => r.id === id);
    if (!row) throw new Error(`Unknown plugin “${id}”`);
    const store = this.config.extensions;
    if (store?.has(id)) row.disabled = store.rows().find((r) => r.id === id)!.disabled;
    const fiber = this.fibers.get(id);
    this.fibers.delete(id);
    this.errors.delete(id);
    if (fiber) await fiber.dispose();
    await this.settle();
    if (!row.disabled) {
      await this.start(row);
      await this.settle();
    }
    this.notify();
    return this.snapshot();
  }

  /** `disabled`: a first install goes on switched off; an update keeps the switch it had. */
  async installFile(file: string, opts: { source?: "store" | "file"; digest?: string; attestation?: unknown; disabled?: boolean } = {}): Promise<PluginsSnapshot> {
    const entry = await this.store().installFile(file, { ...opts, vet: (manifest) => this.vetRows(manifest) });
    return this.add({ id: entry.id, name: `ext:${entry.id}`, disabled: entry.disabled });
  }

  addFolder(dir: string, source: "folder" | "studio" = "folder"): Promise<PluginsSnapshot> {
    const entry = this.store().addFolder(dir, source, (manifest) => this.vetRows(manifest));
    const row = this.store().rows().find((r) => r.id === entry.id)!;
    return this.add(row);
  }

  async confirm(id: string, digest: string): Promise<PluginsSnapshot> {
    this.store().confirm(id, digest);
    return this.reload(id);
  }

  async allowVersion(id: string): Promise<PluginsSnapshot> {
    this.store().allowVersion(id);
    return this.reload(id);
  }

  async withdrawVersion(id: string): Promise<PluginsSnapshot> {
    this.store().withdrawVersion(id);
    return this.reload(id);
  }

  async rollback(id: string): Promise<PluginsSnapshot> {
    this.store().rollback(id);
    return this.reload(id);
  }

  async uninstall(id: string, opts: { removeData?: boolean } = {}): Promise<PluginsSnapshot> {
    const snapshot = await this.remove(id);
    if (this.config.rows.some((r) => r.id === id)) return snapshot;
    this.store().uninstall(id, opts);
    this.notify();
    return this.snapshot();
  }

  private async apply(id: string, enabled: boolean): Promise<PluginsSnapshot> {
    const row = this.config.rows.find((r) => r.id === id);
    if (!row) throw new Error(`Unknown plugin “${id}”`);
    if (!row.disabled === enabled) return this.snapshot();

    if (enabled) {
      row.disabled = false;
      await this.start(row);
      await this.settle();
    } else {
      await this.disable(row);
    }

    if (this.config.extensions?.has(id)) this.config.extensions.setDisabled(id, !enabled);
    else await this.config.persist?.(id, !enabled);
    this.notify();
    return this.snapshot();
  }

  private async disable(row: PluginRow): Promise<void> {
    // The cheap refusal, taken before anything is torn down: this row is the
    // only thing on the context providing a module nothing may run without.
    const held = this.soleProviders(this.providers()).get(row.id);
    if (held?.length) throw new RequiredModuleError(row.id, this.viewsOf(held));

    // A module standing empty before the switch — a row this composition never
    // had, or one that failed to load — is not this switch's doing. Refusing
    // over it would lock every plugin in the list behind an unrelated fault.
    const filled = new Set(this.modules().flatMap((m) => (m.providers.length ? [m.id] : [])));

    const fiber = this.fibers.get(row.id);
    row.disabled = true;
    this.fibers.delete(row.id);
    this.errors.delete(row.id);
    if (fiber) await fiber.dispose();
    await this.settle();

    // Unloading cascades — whatever injected this row's services went with it.
    // Only the context itself can say whether that emptied a required module,
    // so ask it, and put the row back if the answer is yes.
    const emptied = this.modules().filter((m) => m.required && !m.providers.length && filled.has(m.id));
    if (!emptied.length) return;
    row.disabled = false;
    await this.start(row);
    await this.settle();
    throw new RequiredModuleError(row.id, emptied);
  }

  /**
   * A full-mode extension whose rows switch off the last provider of a required
   * module is refused as it is installed. A row that replaces one is judged when
   * its rows are laid on, at the next start.
   */
  private vetRows(manifest: Manifest): void {
    if (manifest.context !== "full") return;
    const held = this.soleProviders(this.providers());
    for (const row of manifest.rows) {
      const modules = row.disabled ? held.get(row.id) : undefined;
      if (!modules?.length) continue;
      const titles = this.viewsOf(modules).map((m) => m.title);
      throw new ExtensionRefused(`${manifest.id} switches off “${row.id}”, which would leave ${titles.join(", ")} with no plugin`);
    }
  }

  /**
   * Rows of full-mode extensions that left a required module empty are taken
   * back, the extension laid on last first, and each one taken back is told
   * which modules its rows emptied. One whose rows were not the cause is put back.
   */
  private async keepRequired(): Promise<void> {
    const recompose = this.config.recompose;
    const from = this.config.rowsFrom ?? [];
    if (!recompose || !from.length) return;
    const empty = () => this.modules().filter((m) => m.required && !m.providers.length).map((m) => m.id);
    const without = new Set<string>();
    for (const id of [...from].reverse()) {
      const before = empty();
      if (!before.length) return;
      without.add(id);
      await this.lay(recompose(without));
      const filled = before.filter((m) => !empty().includes(m));
      if (filled.length) {
        this.rowsRefused.set(id, this.viewsOf(filled).map((m) => m.title));
        this.home.logger.warn(`${id}: its rows left ${this.rowsRefused.get(id)!.join(", ")} with no plugin, so this start runs without them`);
      } else {
        without.delete(id);
        await this.lay(recompose(without));
      }
    }
  }

  /** Bring the composition's own rows to `next`: a changed row restarts, a row gone stops, a new row starts. Extensions' rows stay. */
  private async lay(next: PluginRow[]): Promise<void> {
    const same = (a: PluginRow, b: PluginRow) => a.name === b.name && !!a.disabled === !!b.disabled && a.from === b.from && JSON.stringify(a.config) === JSON.stringify(b.config);
    const stop = async (id: string) => {
      const fiber = this.fibers.get(id);
      this.fibers.delete(id);
      this.errors.delete(id);
      if (fiber) await fiber.dispose();
    };
    for (const row of [...this.config.rows]) {
      if (row.name.startsWith("ext:") || next.some((n) => n.id === row.id)) continue;
      await stop(row.id);
      this.config.rows = this.config.rows.filter((r) => r.id !== row.id);
    }
    for (const want of next) {
      const at = this.config.rows.findIndex((r) => r.id === want.id);
      if (at >= 0 && same(this.config.rows[at]!, want)) continue;
      if (at >= 0) await stop(want.id);
      const row = { ...want };
      if (at >= 0) this.config.rows[at] = row;
      else this.config.rows.push(row);
      if (!row.disabled) await this.start(row);
    }
    await this.settle();
  }

  private async start(row: PluginRow): Promise<void> {
    this.errors.delete(row.id);
    try {
      const store = this.config.extensions;
      const plugin = row.name.startsWith("ext:") && store ? await store.load(row.id) : await this.config.resolve(row);
      if (row.from) store?.claim(plugin as object, row.from);
      this.fibers.set(row.id, this.home.plugin(plugin, row.config));
    } catch (error) {
      this.errors.set(row.id, error);
      this.home.logger.error(`${row.id}: ${messageOf(error)}`);
    }
  }

  /**
   * A fiber whose dependencies arrive later starts loading after the notify
   * that brings them, so settle until no fiber is mid-flight.
   */
  private async settle(): Promise<void> {
    let loading = true;
    while (loading) {
      for (const [id, fiber] of this.fibers) {
        try {
          await fiber;
        } catch (error) {
          this.errors.set(id, error);
        }
      }
      await tick();
      loading = [...this.fibers.values()].some((f) => f.state === 1 || f.state === 5);
    }
  }

  private describe(row: PluginRow, provides: string[], holds: string[]): PluginView {
    const fiber = this.fibers.get(row.id);
    const error = this.errors.get(row.id);
    const base: Omit<PluginView, "state"> = { id: row.id, name: row.name, ...(row.title ? { title: row.title } : {}), config: row.config, provides, injects: Object.keys(fiber?.inject ?? {}), holds, implements: this.contractsOf(row, fiber) };
    const store = this.config.extensions;
    const refused = this.rowsRefused.get(row.id);
    if (refused) base.rowsRefused = refused;
    if (store?.has(row.id)) {
      try {
        base.extension = store.info(row.id);
      } catch (error) {
        return { ...base, state: "failed", error: messageOf(error) };
      }
    }
    if (row.disabled) return { ...base, state: "disabled" };
    if (error || !fiber) return { ...base, state: "failed", error: messageOf(error ?? "not loaded") };
    const state = STATE[fiber.state] ?? "pending";
    const waitingFor = state === "pending" ? Object.keys(fiber.inject).filter((name) => this.home.get(name) === undefined) : undefined;
    return { ...base, state, ...(waitingFor?.length ? { waitingFor } : {}) };
  }

  /**
   * Which row puts each live service on the context. Read from the context
   * rather than from a declaration, so a row that loads further plugins — and
   * every row here may — is credited with what they provide.
   */
  private providers(): Map<string, string[]> {
    // Fibers reach us through cordis' tracing proxy, so they never compare
    // equal to the ones we hold; `uid` is the identity that survives it.
    const owners = new Map<number, string>();
    for (const [id, fiber] of this.fibers) {
      if (fiber.uid !== null) owners.set(fiber.uid, id);
    }

    const store = this.home.reflect.store as Record<symbol, Impl | undefined>;
    const out = new Map<string, string[]>();
    for (const key of Reflect.ownKeys(store)) {
      const impl = store[key as symbol];
      if (!impl) continue;
      const id = this.ownerOf(impl.fiber, owners);
      if (id) out.set(impl.name, [...(out.get(impl.name) ?? []), id]);
    }
    return out;
  }

  /**
   * Declared on the row, because a switched-off row registers nothing — and a
   * disabled engine is the one someone opens this pane to find. A running row
   * is also credited with every registry its effects are labelled with.
   */
  private contractsOf(row: PluginRow, fiber: Fiber | undefined): string[] {
    const labels: string[] = [];
    const walk = (effects: EffectMeta[]) => {
      for (const effect of effects) {
        labels.push(effect.label);
        walk(effect.children);
      }
    };
    if (fiber && !row.disabled) walk(fiber.getEffects());
    const declared = new Set(row.implements ?? []);
    return (this.config.contracts ?? [])
      .filter((c) => declared.has(c.id) || labels.some((label) => label.startsWith(`${c.registry}(`)))
      .map((c) => c.id);
  }

  /** Walk out of nested fibers until one of them is a row of the composition. */
  private ownerOf(fiber: Fiber, owners: Map<number, string>): string | undefined {
    const seen = new Set<number>();
    let current: Fiber | undefined = fiber;
    while (current?.uid != null && !seen.has(current.uid)) {
      const id = owners.get(current.uid);
      if (id) return id;
      seen.add(current.uid);
      current = current.parent?.fiber;
    }
    return undefined;
  }

  /** Plugin id → the required modules it is the last one holding up. */
  private soleProviders(provided: Map<string, string[]>): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const module of this.config.modules ?? []) {
      if (module.required !== true) continue;
      const providers = provided.get(module.id) ?? [];
      if (providers.length !== 1) continue;
      const id = providers[0]!;
      out.set(id, [...(out.get(id) ?? []), module.id]);
    }
    return out;
  }

  private viewsOf(ids: string[]): ModuleView[] {
    const byId = new Map(this.modules().map((m) => [m.id, m]));
    return ids.flatMap((id) => byId.get(id) ?? []);
  }
}

export default Plugins;
