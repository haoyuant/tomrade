import { Context, Service } from "cordis";
import type { Item } from "@tomradex/domain";
import type {} from "@tomradex/ipc";
import type {} from "@tomradex/items";

export interface CommandScope {
  projectId?: string;
  boardId?: string;
  viewId?: string;
  itemId?: string | null;
}

export interface CommandResult {
  toast?: string;
  /** A conversation the renderer should bring up in the assistant panel. */
  showThread?: string;
  /** The project that conversation lives in, when the command ran without one (the projects home). */
  projectId?: string;
  /** A settings pane the renderer should show ("about"). */
  settingsPane?: string;
  /** Starting the scoped ticket stopped on something the Start dialog can fix: open it there, in this mode. */
  startDialog?: "run" | "terminal";
}

/** Words a plugin may compute when shown, so they come out in the person's language at that moment. */
export type Words = string | (() => string);
const said = (w: Words | undefined): string | undefined => (typeof w === "function" ? w() : w);

export interface Command {
  id: string;
  title: Words;
  /** Palette group heading; defaults to "Plugins". */
  group?: Words;
  shortcut?: string;
  run(scope: CommandScope): CommandResult | void | Promise<CommandResult | void>;
}

export interface CommandView {
  id: string;
  title: string;
  group?: string;
  shortcut?: string;
}

export type BadgeTone = "faint" | "neutral" | "strong";

export interface Badge {
  id: string;
  label: string;
  tone?: BadgeTone;
  title?: string;
}

export interface BadgeProvider {
  id: string;
  /** Item id → badges. Computed in the main process on every board refresh. */
  compute(items: Item[], scope: { projectId: string }): Record<string, Badge[]> | Promise<Record<string, Badge[]>>;
}

export interface StatusItem {
  id: string;
  /** Null hides the item. */
  text(scope: { projectId?: string }): string | null | Promise<string | null>;
  /** A renderer surface the item opens when clicked, by name ("code-inbox"); absent, the item is plain text. */
  opens?: string;
  /** A command the item runs when clicked, its result handled as the palette handles it. */
  command?: string;
  /** Hover text. */
  title?: Words;
  /** Icon id from the renderer's sprite, drawn before the text; unknown names draw nothing. */
  icon?: string;
  /** Which end of the bar it sits at; absent, the left cluster after the live items. */
  align?: "start" | "end";
}

export interface StatusItemView {
  id: string;
  text: string;
  opens?: string;
  command?: string;
  title?: string;
  icon?: string;
  align?: "start" | "end";
}

export interface GraphEdge {
  /** Item ids. The renderer draws nodes for the items it already shows. */
  from: string;
  to: string;
  tone?: BadgeTone | "danger";
  title?: string;
}

/**
 * A way of arranging the board's issues as nodes and arrows. The renderer owns
 * the canvas and the item cards; the plugin says only which arrows exist.
 */
export interface GraphSpec {
  id: string;
  title: string;
  /** Icon id from the renderer's sprite; unknown names fall back. */
  icon?: string;
  /** "blocks" lets the canvas edit edges by writing Item.blocks patches. */
  edits?: "blocks";
  compute(items: Item[], scope: { projectId: string }): GraphEdge[] | Promise<GraphEdge[]>;
}

export type GraphInfo = Omit<GraphSpec, "compute">;

/**
 * What a row's value is doing right now, drawn as a mark before it: `live`
 * breathes, `waiting` blinks (someone's turn), the rest are steady; hollow marks
 * (`ended`, `lost`) say the thing is over. The word in the value stays the signal;
 * the mark confirms it.
 */
export type SectionState = "live" | "waiting" | "idle" | "ended" | "lost" | "ok" | "warn";

export interface SectionRow {
  label: string;
  value: string;
  /** Icon id from the renderer's sprite, drawn before the label; unknown ids draw nothing. */
  icon?: string;
  /** The value is an identifier — a branch, a hash, a path — and is set in the mono face. */
  mono?: boolean;
  state?: SectionState;
  /** The value opens this link in the browser. */
  href?: string;
  /** The value runs this palette command with the item in scope. */
  command?: string;
}

export interface Section {
  id: string;
  title: Words;
  /** Null hides the section for this item. */
  render(item: Item): SectionContent | null | Promise<SectionContent | null>;
}

export interface SectionContent {
  rows?: SectionRow[];
  text?: string;
}

export interface SectionView {
  id: string;
  title: string;
  rows: SectionRow[];
  text?: string;
}

export interface ImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One state of an accessory: a still or animated image, played with its own frame timings. */
export interface AccessoryAnimation {
  /** Renderer-safe URL, normally a data URL supplied by the contributing plugin. */
  source: string;
  /** The image's MIME type, which the renderer's decoder needs. */
  type: string;
  /** The part worth showing, in image pixels; it is fitted to the stage, bottom-aligned. The whole image when absent. */
  box?: ImageBox;
  /** Nearest-neighbour scaling for pixel art; everything else scales smoothly. */
  pixelated?: boolean;
}

/**
 * Declarative content for the assistant accessory slot. The renderer owns the
 * stage and the player; plugins provide only dimensions and animation data.
 */
export interface AssistantAccessory {
  id: string;
  kind: "animated-pet";
  title: string;
  /** `(threadId: string | null) => { mood: string }`. */
  stateChannel: string;
  /** Broadcast shape: `(threadId: string, state: { mood: string })`. */
  changedChannel: string;
  width: number;
  height: number;
  animations: Record<string, AccessoryAnimation>;
}

declare module "cordis" {
  interface Context {
    contributions: Contributions;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "contributions.commands": () => CommandView[];
    "contributions.run": (id: string, scope: CommandScope) => CommandResult;
    "contributions.badges": (projectId: string) => Record<string, Badge[]>;
    "contributions.statusItems": (scope: { projectId?: string }) => StatusItemView[];
    "contributions.sections": (projectId: string, itemId: string) => SectionView[];
    "contributions.graphs": () => GraphInfo[];
    "contributions.graph": (id: string, scope: { projectId: string }) => GraphEdge[];
    "contributions.assistantAccessories": () => AssistantAccessory[];
  }
  interface Broadcasts {
    "contributions.changed": () => void;
  }
}

export class Contributions extends Service {
  static provide = "contributions";
  static inject = ["items"];

  private commandMap = new Map<string, Command>();
  private badgeMap = new Map<string, BadgeProvider>();
  private statusMap = new Map<string, StatusItem>();
  private sectionMap = new Map<string, Section>();
  private graphMap = new Map<string, GraphSpec>();
  private assistantAccessoryMap = new Map<string, AssistantAccessory>();
  private notify: () => void = () => {};

  constructor(ctx: Context) {
    super(ctx, "contributions");
  }

  [Service.init]() {
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("contributions.commands", () => ctx.contributions.commands());
      ctx.ipc.handle("contributions.run", (id, scope) => ctx.contributions.run(id, scope));
      ctx.ipc.handle("contributions.badges", (projectId) => ctx.contributions.badgesFor(projectId));
      ctx.ipc.handle("contributions.statusItems", (scope) => ctx.contributions.statusItems(scope));
      ctx.ipc.handle("contributions.sections", (projectId, itemId) => ctx.contributions.sectionsFor(projectId, itemId));
      ctx.ipc.handle("contributions.graphs", () => ctx.contributions.graphs());
      ctx.ipc.handle("contributions.graph", (id, scope) => ctx.contributions.graphEdges(id, scope));
      ctx.ipc.handle("contributions.assistantAccessories", () => ctx.contributions.assistantAccessories());
      this.notify = () => ctx.ipc.send("contributions.changed");
      return () => {
        this.notify = () => {};
      };
    });
  }

  command(def: Command): () => void {
    return this.add(this.commandMap, def, "command");
  }

  badge(def: BadgeProvider): () => void {
    return this.add(this.badgeMap, def, "badge");
  }

  statusItem(def: StatusItem): () => void {
    return this.add(this.statusMap, def, "statusItem");
  }

  section(def: Section): () => void {
    return this.add(this.sectionMap, def, "section");
  }

  graph(def: GraphSpec): () => void {
    return this.add(this.graphMap, def, "graph");
  }

  assistantAccessory(def: AssistantAccessory): () => void {
    return this.add(this.assistantAccessoryMap, def, "assistantAccessory");
  }

  commands(): CommandView[] {
    return [...this.commandMap.values()].map((c) => ({ id: c.id, title: said(c.title)!, ...(c.group ? { group: said(c.group) } : {}), ...(c.shortcut ? { shortcut: c.shortcut } : {}) }));
  }

  async run(id: string, scope: CommandScope): Promise<CommandResult> {
    const command = this.commandMap.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    return (await command.run(scope)) ?? {};
  }

  async badgesFor(projectId: string): Promise<Record<string, Badge[]>> {
    if (!this.badgeMap.size) return {};
    const items = this.ctx.items.list({ projectId });
    const out: Record<string, Badge[]> = {};
    const computed = await Promise.all([...this.badgeMap.values()].map((provider) => this.isolated(`badge ${provider.id}`, () => provider.compute(items, { projectId }), {})));
    for (const result of computed) {
      for (const [itemId, badges] of Object.entries(result)) (out[itemId] ??= []).push(...badges);
    }
    return out;
  }

  async statusItems(scope: { projectId?: string }): Promise<StatusItemView[]> {
    const texts = await Promise.all([...this.statusMap.values()].map(async (s) => ({ id: s.id, opens: s.opens, command: s.command, title: said(s.title), icon: s.icon, align: s.align, text: await this.isolated(`status item ${s.id}`, () => s.text(scope), null) })));
    return texts.flatMap((t) => (t.text ? [{ id: t.id, text: t.text, ...(t.opens ? { opens: t.opens } : {}), ...(t.command ? { command: t.command } : {}), ...(t.title ? { title: t.title } : {}), ...(t.icon ? { icon: t.icon } : {}), ...(t.align ? { align: t.align } : {}) }] : []));
  }

  graphs(): GraphInfo[] {
    return [...this.graphMap.values()].map(({ compute: _compute, ...info }) => info);
  }

  assistantAccessories(): AssistantAccessory[] {
    return [...this.assistantAccessoryMap.values()];
  }

  async graphEdges(id: string, scope: { projectId: string }): Promise<GraphEdge[]> {
    const graph = this.graphMap.get(id);
    if (!graph) throw new Error(`Unknown graph: ${id}`);
    return graph.compute(this.ctx.items.list({ projectId: scope.projectId }), scope);
  }

  async sectionsFor(projectId: string, itemId: string): Promise<SectionView[]> {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) return [];
    const sections = [...this.sectionMap.values()];
    const rendered = await Promise.all(sections.map((s) => this.isolated(`section ${s.id}`, () => s.render(item), null)));
    return sections.flatMap((s, i) => {
      const r = rendered[i];
      return r ? [{ id: s.id, title: said(s.title)!, rows: r.rows ?? [], text: r.text }] : [];
    });
  }

  /** One contribution that throws or stalls costs only itself, never the refresh it is part of. */
  private async isolated<T>(label: string, fn: () => T | Promise<T>, fallback: T): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      this.ctx.logger("contributions").warn(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  }

  /** Reversible, and announced to every window so the renderer refetches. */
  private add<T extends { id: string }>(map: Map<string, T>, def: T, kind: string): () => void {
    if (map.has(def.id)) throw new Error(`${kind} "${def.id}" is already registered`);
    return this.ctx.effect(() => {
      map.set(def.id, def);
      this.notify();
      return () => {
        map.delete(def.id);
        this.notify();
      };
    }, `contributions.${kind}(${def.id})`);
  }
}

export default Contributions;
