import { Context, Service } from "cordis";
import { z } from "zod";
import type { AgentEvent } from "@tomradex/agent";
import type { DesktopSurface, DesktopSurfaceHost } from "@tomradex/desktop-surface";
import type { SettingsSection } from "@tomradex/settings";
import type {} from "@tomradex/contributions";
import type {} from "@tomradex/ipc";
import { desktopAnimation, embeddedAccessory, PET_DESKTOP_URL } from "./manifest.js";
import { desktopThreadState, emptyPetModel, moodForThread, reducePetModel, type PetModel, type PetMood, type TaskPetMood } from "./state.js";

export * from "./state.js";
export { PET_ANIMATIONS } from "./manifest.js";

export interface PetSettings {
  enabled: boolean;
  displayMode: "embedded" | "desktop";
  roam: boolean;
  roamSpeed: "slow" | "normal" | "quick";
  size: "small" | "medium" | "large";
  clickThrough: boolean;
  allWorkspaces: boolean;
}

export interface PetViewState {
  mood: TaskPetMood;
  threadId: string | null;
}

export const PET_SECTION: SettingsSection<PetSettings> = {
  id: "pet",
  title: "Pet",
  description: "An orange-and-white companion that reflects assistant activity. Disable the plugin itself in Manage plugins to unload it completely.",
  schema: z.object({
    enabled: z.boolean().default(true).meta({ title: "Enabled" }).describe("Show the pet while this plugin is loaded."),
    displayMode: z.enum(["embedded", "desktop"]).default("embedded").meta({ title: "Display mode" }).describe("Embed above the assistant composer, or use an independent desktop window."),
    roam: z.boolean().default(true).meta({ title: "Roam on desktop" }).describe("Walk around the current display while no assistant needs attention."),
    roamSpeed: z.enum(["slow", "normal", "quick"]).default("normal").meta({ title: "Roam speed" }),
    size: z.enum(["small", "medium", "large"]).default("medium").meta({ title: "Desktop size" }),
    clickThrough: z.boolean().default(true).meta({ title: "Transparent click-through" }).describe("Pass clicks through transparent pixels; drag the opaque cat."),
    allWorkspaces: z.boolean().default(true).meta({ title: "All workspaces" }).describe("Keep the desktop pet visible when switching virtual desktops.")
  }),
  defaults: { enabled: true, displayMode: "embedded", roam: true, roamSpeed: "normal", size: "medium", clickThrough: true, allWorkspaces: true },
  order: 20,
  scope: "machine"
};

declare module "cordis" {
  interface Context {
    pet: Pet;
  }
}

declare module "@tomradex/ipc" {
  interface Channels {
    "pet.state": (threadId: string | null) => PetViewState;
  }
  interface Broadcasts {
    "pet.changed": (threadId: string, state: PetViewState) => void;
  }
}

const SIZE = {
  small: { width: 132, height: 105 },
  medium: { width: 176, height: 140 },
  large: { width: 220, height: 175 }
} as const;

const SPEED = { slow: 55, normal: 90, quick: 140 } as const;

const isMotionMessage = (message: unknown): message is { type: "reduced-motion"; value: boolean } =>
  typeof message === "object" && message !== null && (message as { type?: unknown }).type === "reduced-motion" && typeof (message as { value?: unknown }).value === "boolean";

/** The feature owner: state, settings, contribution, IPC, timers and surface lifecycle all terminate here. */
export class Pet extends Service {
  static provide = "pet";
  static inject = ["agent", "settings", "contributions"];

  private model: PetModel = emptyPetModel();
  private sendChanged: (threadId: string) => void = () => {};
  private accessoryDispose: (() => void) | null = null;
  private surfaceHost: DesktopSurfaceHost | null = null;
  private surface: DesktopSurface | null = null;
  private surfaceSignature = "";
  private successTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private roamTimer: ReturnType<typeof setTimeout> | null = null;
  private moveTimer: ReturnType<typeof setInterval> | null = null;
  private walking = false;
  private reducedMotion = false;

  constructor(ctx: Context) {
    super(ctx, "pet");
  }

  [Service.init]() {
    this.ctx.settings.register(PET_SECTION);
    this.bootstrapActivity();
    this.ctx.on("agent/event", (threadId, event) => this.consume(threadId, event));
    this.ctx.on("settings/changed", () => this.reconcile());
    this.ctx.inject(["ipc"], (ctx) => {
      ctx.ipc.handle("pet.state", (threadId) => this.state(threadId));
      this.sendChanged = (threadId) => ctx.ipc.send("pet.changed", threadId, this.state(threadId));
      return () => {
        this.sendChanged = () => {};
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
    this.model = reducePetModel(this.model, threadId, event);
    const state = this.model.threads[threadId];
    if (state.mood === "success") this.returnSuccessToIdle(threadId, state.sequence);
    else this.clearSuccessTimer(threadId);
    this.sendChanged(threadId);

    const desktop = desktopThreadState(this.model);
    if (desktop.mood !== "idle") this.stopRoaming(false);
    this.pushSurfaceState();
    this.syncRoaming();
  }

  private returnSuccessToIdle(threadId: string, sequence: number): void {
    this.clearSuccessTimer(threadId);
    const timer = setTimeout(() => {
      this.successTimers.delete(threadId);
      const before = this.model.threads[threadId];
      if (!before || before.mood !== "success" || before.sequence !== sequence) return;
      const nextSequence = this.model.sequence + 1;
      this.model = { sequence: nextSequence, threads: { ...this.model.threads, [threadId]: { mood: "idle", runId: before.runId, sequence: nextSequence } } };
      this.sendChanged(threadId);
      this.pushSurfaceState();
      this.syncRoaming();
    }, 2_600);
    this.successTimers.set(threadId, timer);
  }

  private clearSuccessTimer(threadId: string): void {
    const timer = this.successTimers.get(threadId);
    if (timer) clearTimeout(timer);
    this.successTimers.delete(threadId);
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
      if (!this.accessoryDispose) this.accessoryDispose = this.ctx.contributions.assistantAccessory(embeddedAccessory());
      return;
    }

    this.removeAccessory();
    if (!this.surfaceHost) return;
    const signature = JSON.stringify({ size: settings.size, clickThrough: settings.clickThrough, allWorkspaces: settings.allWorkspaces });
    if (this.surface && signature === this.surfaceSignature) {
      this.pushSurfaceState();
      this.syncRoaming();
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
        if (!isMotionMessage(message)) return;
        this.reducedMotion = message.value;
        if (this.reducedMotion) this.stopRoaming();
        else this.syncRoaming();
      }
    });
    this.pushSurfaceState();
    this.syncRoaming();
  }

  private removeAccessory(): void {
    this.accessoryDispose?.();
    this.accessoryDispose = null;
  }

  private closeSurface(): void {
    this.stopRoaming(false);
    this.surface?.close();
    this.surface = null;
    this.surfaceSignature = "";
    this.reducedMotion = false;
  }

  private surfacePayload(forcedMood?: PetMood) {
    const selected = desktopThreadState(this.model);
    const mood = forcedMood ?? selected.mood;
    return {
      mood,
      threadId: selected.threadId,
      animation: desktopAnimation(mood),
      roamingAvailable: Boolean(this.surface?.capabilities.programmaticPosition) && !this.reducedMotion
    };
  }

  private pushSurfaceState(): void {
    if (!this.surface) return;
    this.surface.setState(this.surfacePayload(this.walking ? "walk" : undefined));
  }

  private syncRoaming(): void {
    const settings = this.settings();
    const canRoam =
      settings.enabled &&
      settings.displayMode === "desktop" &&
      settings.roam &&
      !this.reducedMotion &&
      this.surface?.capabilities.programmaticPosition &&
      desktopThreadState(this.model).mood === "idle";
    if (!canRoam) {
      this.stopRoaming();
      return;
    }
    if (this.roamTimer || this.moveTimer) return;
    this.roamTimer = setTimeout(() => {
      this.roamTimer = null;
      this.beginRoam();
    }, 4_000 + Math.round(Math.random() * 4_000));
  }

  private beginRoam(): void {
    const surface = this.surface;
    if (!surface || desktopThreadState(this.model).mood !== "idle" || this.reducedMotion) return;
    const from = surface.bounds();
    const area = surface.workArea();
    const target = {
      x: area.x + Math.random() * Math.max(0, area.width - from.width),
      y: area.y + Math.random() * Math.max(0, area.height - from.height)
    };
    const distance = Math.hypot(target.x - from.x, target.y - from.y);
    if (distance < 20) {
      this.syncRoaming();
      return;
    }
    const duration = (distance / SPEED[this.settings().roamSpeed]) * 1_000;
    const began = Date.now();
    this.walking = true;
    this.pushSurfaceState();
    this.moveTimer = setInterval(() => {
      if (!this.surface) return this.stopRoaming(false);
      const t = Math.min(1, (Date.now() - began) / duration);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      this.surface.setPosition(from.x + (target.x - from.x) * eased, from.y + (target.y - from.y) * eased);
      if (t < 1) return;
      if (this.moveTimer) clearInterval(this.moveTimer);
      this.moveTimer = null;
      this.walking = false;
      this.pushSurfaceState();
      this.syncRoaming();
    }, 33);
  }

  private stopRoaming(resetVisual = true): void {
    if (this.roamTimer) clearTimeout(this.roamTimer);
    if (this.moveTimer) clearInterval(this.moveTimer);
    this.roamTimer = null;
    this.moveTimer = null;
    const wasWalking = this.walking;
    this.walking = false;
    if (resetVisual && wasWalking) this.pushSurfaceState();
  }

  private deactivate(): void {
    this.removeAccessory();
    this.closeSurface();
    for (const timer of this.successTimers.values()) clearTimeout(timer);
    this.successTimers.clear();
  }
}

export default Pet;
