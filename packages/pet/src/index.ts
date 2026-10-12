import { Context, Service } from "cordis";
import { z } from "zod";
import type { AgentEvent } from "@tomradex/agent";
import type { DesktopSurface, DesktopSurfaceHost } from "@tomradex/desktop-surface";
import type { SettingsSection } from "@tomradex/settings";
import type { AccessoryAnimation } from "@tomradex/contributions";
import type {} from "@tomradex/ipc";
import { BUILT_IN_IMAGES, dataAnimation, embeddedAccessory, fileAnimation, PET_DESKTOP_URL } from "./manifest.js";
import { PetProfiles, type PetImageUpload, type PetProfileView, type PetProfilesView, type ResolvedImage } from "./profiles.js";
import { emptyPetModel, moodForThread, PET_MOODS, reducePetModel, type PetModel, type PetMood } from "./state.js";

export * from "./state.js";
export { DEFAULT_PROFILE, MAX_IMAGE_BYTES, MAX_NAME_LENGTH, sniffImage, type PetImageUpload, type PetProfileView, type PetProfilesView } from "./profiles.js";

export const PetConfig = z.preprocess(
  (value) => value ?? {},
  z.object({
    /** This machine's folder for pets made from the user's own images; without one only the built-in pet exists. */
    profilesDir: z.string().optional()
  })
);
export type PetConfig = z.infer<typeof PetConfig>;

export interface PetSettings {
  enabled: boolean;
  displayMode: "embedded" | "desktop";
  size: "small" | "medium" | "large";
  clickThrough: boolean;
  allWorkspaces: boolean;
}

export interface PetViewState {
  mood: PetMood;
  threadId: string | null;
}

export type PetPreview = AccessoryAnimation & { custom: boolean };

export const PET_SECTION: SettingsSection<PetSettings> = {
  id: "pet",
  title: "Pet",
  description: "An orange-and-white companion that reflects assistant activity. Disable the plugin itself in Manage plugins to unload it completely.",
  schema: z.object({
    enabled: z.boolean().default(true).meta({ title: "Enabled" }).describe("Show the pet while this plugin is loaded."),
    displayMode: z.enum(["embedded", "desktop"]).default("embedded").meta({ title: "Display mode" }).describe("Embed above the assistant composer, or float in its own window you can drag anywhere."),
    size: z.enum(["small", "medium", "large"]).default("medium").meta({ title: "Desktop size" }),
    clickThrough: z.boolean().default(true).meta({ title: "Transparent click-through" }).describe("Pass clicks through transparent pixels; drag the opaque cat."),
    allWorkspaces: z.boolean().default(true).meta({ title: "All workspaces" }).describe("Keep the desktop pet visible when switching virtual desktops.")
  }),
  defaults: { enabled: true, displayMode: "embedded", size: "medium", clickThrough: true, allWorkspaces: true },
  order: 20,
  scope: "machine",
  agent: "write",
  words: {
    en: { fields: { displayMode: { options: { embedded: "Embedded", desktop: "On the desktop" } }, size: { options: { small: "Small", medium: "Medium", large: "Large" } } } },
    zh: {
      title: "宠物",
      description: "一只橘白相间的小伙伴，跟着助手的活动变换状态。想彻底卸载它，请在“管理插件”里停用这个插件。",
      fields: {
        enabled: { title: "启用", description: "插件加载时显示宠物。" },
        displayMode: { title: "显示方式", description: "嵌在助手输入框上方，或者浮在独立的窗口里，可以拖到任何地方。", options: { embedded: "嵌入", desktop: "桌面" } },
        size: { title: "桌面尺寸", options: { small: "小", medium: "中", large: "大" } },
        clickThrough: { title: "透明处点击穿透", description: "点击透明像素会穿透到下面；拖动不透明的猫来移动它。" },
        allWorkspaces: { title: "所有桌面", description: "切换虚拟桌面时，桌面宠物依然可见。" }
      }
    }
  }
};

declare module "cordis" {
  interface Context {
    pet: Pet;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "pet.state": (threadId: string | null) => PetViewState;
    "pet.profiles": () => PetProfilesView;
    "pet.profilePreview": (profileId: string) => Record<PetMood, PetPreview>;
    "pet.createProfile": (name: string) => PetProfileView;
    "pet.updateProfile": (profileId: string, patch: { name?: string; pixelated?: boolean }) => PetProfileView;
    "pet.deleteProfile": (profileId: string) => PetProfilesView;
    "pet.activateProfile": (profileId: string) => PetProfilesView;
    "pet.setImage": (profileId: string, mood: PetMood, upload: PetImageUpload) => PetProfileView;
    "pet.clearImage": (profileId: string, mood: PetMood) => PetProfileView;
  }
  interface Broadcasts {
    "pet.changed": (threadId: string, state: PetViewState) => void;
    "pet.profilesChanged": () => void;
  }
}

const SIZE = {
  small: { width: 132, height: 105 },
  medium: { width: 176, height: 140 },
  large: { width: 220, height: 175 }
} as const;

const SETTLE_MS = 3_000;

const isMoveMessage = (message: unknown): message is { type: "move"; x: number; y: number } =>
  typeof message === "object" &&
  message !== null &&
  (message as { type?: unknown }).type === "move" &&
  Number.isFinite((message as { x?: unknown }).x) &&
  Number.isFinite((message as { y?: unknown }).y);

/** The feature owner: state, settings, contribution, IPC, timers and surface lifecycle all terminate here. */
export class Pet extends Service {
  static provide = "pet";
  static inject = ["agent", "settings", "contributions"];
  static Config = PetConfig;

  private readonly store: PetProfiles;
  private model: PetModel = emptyPetModel();
  private sendChanged: (threadId: string) => void = () => {};
  private sendProfilesChanged: () => void = () => {};
  private accessoryDispose: (() => void) | null = null;
  private accessoryKey = "";
  private resolved: { revision: number; images: Record<PetMood, ResolvedImage> } | null = null;
  private surfaceHost: DesktopSurfaceHost | null = null;
  private surface: DesktopSurface | null = null;
  private surfaceSignature = "";
  private settleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The thread the assistant panel shows: the desktop pet follows it, as the embedded stage does. */
  private followed: string | null = null;
  /** Where the user last dragged the desktop pet; a reopened window (new size, setting change) returns there. */
  private position: { x: number; y: number } | null = null;

  constructor(ctx: Context, config: PetConfig) {
    super(ctx, "pet");
    this.store = new PetProfiles(config?.profilesDir ?? null, BUILT_IN_IMAGES);
  }

  [Service.init]() {
    this.ctx.settings.register(PET_SECTION);
    this.bootstrapActivity();
    this.followed = this.ctx.agent.showing();
    this.ctx.on("agent/event", (threadId, event) => this.consume(threadId, event));
    this.ctx.on("agent/showing", (threadId) => {
      this.followed = threadId;
      this.pushSurfaceState();
    });
    this.ctx.on("settings/changed", () => this.reconcile());
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("pet.state", (threadId) => this.state(threadId));
      ctx.ipc.handle("pet.profiles", () => this.profiles());
      ctx.ipc.handle("pet.profilePreview", (profileId) => this.preview(profileId));
      ctx.ipc.handle("pet.createProfile", (name) => this.edit(() => this.store.create(name).id));
      ctx.ipc.handle("pet.updateProfile", (profileId, patch) => this.edit(() => this.store.update(profileId, patch).id));
      ctx.ipc.handle("pet.setImage", (profileId, mood, upload) => this.edit(() => this.store.setImage(profileId, mood, upload).id));
      ctx.ipc.handle("pet.clearImage", (profileId, mood) => this.edit(() => this.store.clearImage(profileId, mood).id));
      ctx.ipc.handle("pet.deleteProfile", (profileId) => {
        this.store.remove(profileId);
        this.profilesChanged();
        return this.profiles();
      });
      ctx.ipc.handle("pet.activateProfile", (profileId) => {
        this.store.activate(profileId);
        this.profilesChanged();
        return this.profiles();
      });
      this.sendChanged = (threadId) => ctx.ipc.send("pet.changed", threadId, this.state(threadId));
      this.sendProfilesChanged = () => ctx.ipc.send("pet.profilesChanged");
      return () => {
        this.sendChanged = () => {};
        this.sendProfilesChanged = () => {};
      };
    });
    this.ctx.inject(["desktopSurfaces"], (ctx) => {
      this.surfaceHost = ctx.desktopSurfaces;
      this.reconcile();
      return () => {
        this.closeSurface();
        this.surfaceHost = null;
      };
    });
    this.reconcile();
    return () => this.deactivate();
  }

  state(threadId: string | null): PetViewState {
    return { mood: moodForThread(this.model, threadId), threadId };
  }

  profiles(): PetProfilesView {
    return this.store.view();
  }

  /** Every mood of one profile as the renderer would draw it, for an editor's previews. */
  preview(profileId: string): Record<PetMood, PetPreview> {
    const images = this.store.resolve(profileId);
    return Object.fromEntries(PET_MOODS.map((mood) => [mood, { ...dataAnimation(images[mood]), custom: images[mood].custom }])) as Record<PetMood, PetPreview>;
  }

  private edit(change: () => string): PetProfileView {
    const id = change();
    this.profilesChanged();
    return this.store.view().profiles.find((p) => p.id === id)!;
  }

  /** The pet on screen redraws only if what the active profile shows actually changed. */
  private profilesChanged(): void {
    this.reconcile();
    this.sendProfilesChanged();
  }

  private images(): Record<PetMood, ResolvedImage> {
    if (this.resolved?.revision !== this.store.revision) this.resolved = { revision: this.store.revision, images: this.store.resolve(this.store.activeId()) };
    return this.resolved.images;
  }

  private settings(): PetSettings {
    return (this.ctx.settings.get().pet as PetSettings | undefined) ?? PET_SECTION.defaults;
  }

  private bootstrapActivity(): void {
    for (const activity of this.ctx.agent.activities()) {
      if (activity.run) this.model = reducePetModel(this.model, activity.threadId, { type: "run", run: activity.run });
      if (activity.pending) this.model = reducePetModel(this.model, activity.threadId, { type: "pending", pending: activity.pending });
    }
  }

  private consume(threadId: string, event: AgentEvent): void {
    const next = reducePetModel(this.model, threadId, event);
    if (next === this.model) return;
    this.model = next;
    const state = this.model.threads[threadId];
    // A failure keeps crying until the thread moves on: like a question, it waits on the person.
    if (state.busy === null && state.mood === "success") this.settleToIdle(threadId, state.sequence);
    else this.clearSettleTimer(threadId);
    this.sendChanged(threadId);
    if (threadId === this.followed) this.pushSurfaceState();
  }

  /** A finished turn shows its success briefly; the pet reflects turns, not the whole thread. */
  private settleToIdle(threadId: string, sequence: number): void {
    this.clearSettleTimer(threadId);
    const timer = setTimeout(() => {
      this.settleTimers.delete(threadId);
      const before = this.model.threads[threadId];
      if (!before || before.sequence !== sequence) return;
      const nextSequence = this.model.sequence + 1;
      this.model = { sequence: nextSequence, threads: { ...this.model.threads, [threadId]: { ...before, mood: "idle", sequence: nextSequence } } };
      this.sendChanged(threadId);
      if (threadId === this.followed) this.pushSurfaceState();
    }, SETTLE_MS);
    this.settleTimers.set(threadId, timer);
  }

  private clearSettleTimer(threadId: string): void {
    const timer = this.settleTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.settleTimers.delete(threadId);
  }

  private reconcile(): void {
    const settings = this.settings();
    if (!settings.enabled) {
      this.removeAccessory();
      this.closeSurface();
      return;
    }
    if (settings.displayMode === "embedded") {
      this.closeSurface();
      this.showAccessory();
      return;
    }

    this.removeAccessory();
    if (!this.surfaceHost) return;
    const signature = JSON.stringify({ size: settings.size, clickThrough: settings.clickThrough, allWorkspaces: settings.allWorkspaces });
    if (this.surface && signature === this.surfaceSignature) {
      this.pushSurfaceState();
      return;
    }
    this.closeSurface();
    const size = SIZE[settings.size];
    this.surfaceSignature = signature;
    this.surface = this.surfaceHost.open({
      id: "tomrade.pet",
      title: "Tomrade pet",
      url: PET_DESKTOP_URL,
      ...size,
      transparent: true,
      alwaysOnTop: true,
      visibleOnAllWorkspaces: settings.allWorkspaces,
      clickThrough: settings.clickThrough,
      initialState: this.surfacePayload(),
      onMessage: (message) => {
        if (!isMoveMessage(message)) return;
        this.position = { x: message.x, y: message.y };
        this.surface?.setPosition(message.x, message.y);
      }
    });
    if (this.position) this.surface.setPosition(this.position.x, this.position.y);
    this.pushSurfaceState();
  }

  private showAccessory(): void {
    const images = this.images();
    const key = JSON.stringify(images);
    if (this.accessoryDispose && key === this.accessoryKey) return;
    this.removeAccessory();
    this.accessoryKey = key;
    this.accessoryDispose = this.ctx.contributions.assistantAccessory(embeddedAccessory(images));
  }

  private removeAccessory(): void {
    this.accessoryDispose?.();
    this.accessoryDispose = null;
    this.accessoryKey = "";
  }

  private closeSurface(): void {
    this.surface?.close();
    this.surface = null;
    this.surfaceSignature = "";
  }

  private surfacePayload() {
    const mood = moodForThread(this.model, this.followed);
    return {
      mood,
      threadId: this.followed,
      animation: fileAnimation(this.images()[mood]),
      // Without programmatic placement (Wayland) the document falls back to the native drag region.
      placeable: this.surface?.capabilities.programmaticPosition ?? true
    };
  }

  private pushSurfaceState(): void {
    this.surface?.setState(this.surfacePayload());
  }

  private deactivate(): void {
    this.removeAccessory();
    this.closeSurface();
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
    this.settleTimers.clear();
  }
}

export default Pet;
