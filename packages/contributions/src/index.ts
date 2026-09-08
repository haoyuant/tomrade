import { Context, Service } from "cordis";
import type { Item } from "@tomrade/domain";
import type {} from "@tomrade/ipc";
import type {} from "@tomrade/items";

export interface CommandScope {
  projectId?: string;
  boardId?: string;
  viewId?: string;
  itemId?: string | null;
}

export interface CommandResult {
  toast?: string;
}

export interface Command {
  id: string;
  title: string;
  /** Palette group heading; defaults to "Plugins". */
  group?: string;
  shortcut?: string;
  run(scope: CommandScope): CommandResult | void | Promise<CommandResult | void>;
}

export type CommandView = Omit<Command, "run">;

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
  compute(items: Item[], scope: { projectId: string }): Record<string, Badge[]>;
}

export interface StatusItem {
  id: string;
  /** Null hides the item. */
  text(scope: { projectId?: string }): string | null;
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
  compute(items: Item[], scope: { projectId: string }): GraphEdge[];
}

export type GraphInfo = Omit<GraphSpec, "compute">;

export interface SectionRow {
  label: string;
  value: string;
}

export interface Section {
  id: string;
  title: string;
  /** Null hides the section for this item. */
  render(item: Item): { rows?: SectionRow[]; text?: string } | null;
}

export interface SectionView {
  id: string;
  title: string;
  rows: SectionRow[];
  text?: string;
}

export interface SpriteAnimation {
  /** Renderer-safe URL, normally a data URL supplied by the contributing plugin. */
  source: string;
  frames: number;
  frameWidth: number;
  frameHeight: number;
  frameMs: number;
  loop?: boolean;
}

/**
 * Declarative content for the assistant accessory slot. The renderer owns the
 * stage and sprite player; plugins provide only dimensions and animation data.
 */
export interface AssistantAccessory {
  id: string;
  kind: "sprite-pet";
  title: string;
  /** `(threadId: string | null) => { mood: string }`. */
  stateChannel: string;
  /** Broadcast shape: `(threadId: string, state: { mood: string })`. */
  changedChannel: string;
  width: number;
  height: number;
  animations: Record<string, SpriteAnimation>;
}

declare module "cordis" {
  interface Context {
    contributions: Contributions;
  }
}

declare module "@tomrade/ipc" {
  interface Channels {
    "contributions.commands": () => CommandView[];
    "contributions.run": (id: string, scope: CommandScope) => CommandResult;
    "contributions.badges": (projectId: string) => Record<string, Badge[]>;
    "contributions.statusItems": (scope: { projectId?: string }) => { id: string; text: string }[];
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
    return [...this.commandMap.values()].map(({ run: _run, ...view }) => view);
  }

  async run(id: string, scope: CommandScope): Promise<CommandResult> {
    const command = this.commandMap.get(id);
    if (!command) throw new Error(`Unknown command: ${id}`);
    return (await command.run(scope)) ?? {};
  }

  badgesFor(projectId: string): Record<string, Badge[]> {
    if (!this.badgeMap.size) return {};
    const items = this.ctx.items.list({ projectId });
    const out: Record<string, Badge[]> = {};
    for (const provider of this.badgeMap.values()) {
      for (const [itemId, badges] of Object.entries(provider.compute(items, { projectId }))) {
        (out[itemId] ??= []).push(...badges);
      }
    }
    return out;
  }

  statusItems(scope: { projectId?: string }): { id: string; text: string }[] {
    return [...this.statusMap.values()].flatMap((s) => {
      const text = s.text(scope);
      return text ? [{ id: s.id, text }] : [];
    });
  }

  graphs(): GraphInfo[] {
    return [...this.graphMap.values()].map(({ compute: _compute, ...info }) => info);
  }

  assistantAccessories(): AssistantAccessory[] {
    return [...this.assistantAccessoryMap.values()];
  }

  graphEdges(id: string, scope: { projectId: string }): GraphEdge[] {
    const graph = this.graphMap.get(id);
    if (!graph) throw new Error(`Unknown graph: ${id}`);
    return graph.compute(this.ctx.items.list({ projectId: scope.projectId }), scope);
  }

  sectionsFor(projectId: string, itemId: string): SectionView[] {
    const item = this.ctx.items.get(projectId, itemId);
    if (!item) return [];
    return [...this.sectionMap.values()].flatMap((s) => {
      const rendered = s.render(item);
      return rendered ? [{ id: s.id, title: s.title, rows: rendered.rows ?? [], text: rendered.text }] : [];
    });
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
