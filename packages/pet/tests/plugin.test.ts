import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Context, Service } from "cordis";
import type { AgentActivity, RunView } from "@tomradex/agent";
import type { AssistantAccessory } from "@tomradex/contributions";
import type { DesktopSurface, DesktopSurfaceSpec, SurfaceBounds } from "@tomradex/desktop-surface";
import { Settings } from "@tomradex/settings";
import { Pet, type PetMood, type PetPreview, type PetProfileView, type PetSettings } from "@tomradex/pet";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pet-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

class FakeAgent extends Service {
  static provide = "agent";
  pending: AgentActivity[] = [];
  activities(): AgentActivity[] {
    return this.pending;
  }
  showing(): string | null {
    return null;
  }
}

class FakeContributions extends Service {
  static provide = "contributions";
  accessories: AssistantAccessory[] = [];
  assistantAccessory(accessory: AssistantAccessory) {
    this.accessories.push(accessory);
    return () => {
      this.accessories = this.accessories.filter((item) => item !== accessory);
    };
  }
}

class FakeIpc extends Service {
  static provide = "ipc";
  handlers = new Map<string, (...args: unknown[]) => unknown>();
  handle(channel: string, handler: (...args: never[]) => unknown) {
    return this.ctx.effect(() => {
      this.handlers.set(channel, handler as (...args: unknown[]) => unknown);
      return () => this.handlers.delete(channel);
    });
  }
  sent: string[] = [];
  send(channel: string) {
    this.sent.push(channel);
  }
  call(channel: string, ...args: unknown[]) {
    return this.handlers.get(channel)!(...args);
  }
}

class FakeSurfaces extends Service {
  static provide = "desktopSurfaces";
  opened: DesktopSurfaceSpec[] = [];
  moves: { x: number; y: number }[] = [];
  states: unknown[] = [];
  closed = 0;

  open(spec: DesktopSurfaceSpec): DesktopSurface {
    this.opened.push(spec);
    let open = true;
    const bounds: SurfaceBounds = { x: 100, y: 100, width: spec.width, height: spec.height };
    return {
      id: spec.id,
      capabilities: { programmaticPosition: true, forwardedMouseMoves: true },
      bounds: () => bounds,
      workArea: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
      setPosition: (x, y) => {
        this.moves.push({ x, y });
        Object.assign(bounds, { x, y });
      },
      setState: (state) => {
        this.states.push(state);
      },
      close: () => {
        if (!open) return;
        open = false;
        this.closed++;
      }
    };
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const run = (status: RunView["status"]): RunView => ({
  id: "run",
  threadId: "thread",
  status,
  engine: "test",
  stop: null,
  error: null,
  usage: null,
  costUsd: null,
  changes: 0,
  reverted: false,
  keptOnRevert: 0,
  startedAt: 1,
  endedAt: status === "running" ? null : 2
});

describe("pet plugin lifecycle", () => {
  it("owns its settings, IPC, contribution and desktop surface across unload/reload", async () => {
    const ctx = new Context();
    await ctx.plugin(Settings, { path: path.join(dir, "settings.json") });
    await ctx.plugin(FakeAgent);
    await ctx.plugin(FakeContributions);
    await ctx.plugin(FakeIpc);
    await ctx.plugin(FakeSurfaces);
    const contributions = ctx.contributions as unknown as FakeContributions;
    const ipc = ctx.ipc as unknown as FakeIpc;
    const surfaces = ctx.desktopSurfaces as unknown as FakeSurfaces;

    const first = await ctx.plugin(Pet);
    await settle();
    expect(ctx.settings.sections().some((section) => section.id === "pet")).toBe(true);
    expect((ctx.settings.get().pet as PetSettings).displayMode).toBe("embedded");
    expect(contributions.accessories.map((item) => item.id)).toEqual(["tomrade.pet"]);
    expect(ipc.handlers.has("pet.state")).toBe(true);
    ctx.emit("agent/event", "thread", { type: "run", run: run("running") });
    expect(ipc.handlers.get("pet.state")?.("thread")).toMatchObject({ mood: "thinking" });
    // A finished turn's outcome stays until the thread runs again, a success as much as a failure.
    vi.useFakeTimers();
    ctx.emit("agent/event", "thread", { type: "done", run: run("done") });
    vi.advanceTimersByTime(60_000);
    expect(ctx.pet.state("thread").mood).toBe("success");
    ctx.emit("agent/event", "thread", { type: "run", run: run("running") });
    expect(ctx.pet.state("thread").mood).toBe("thinking");
    ctx.emit("agent/event", "thread", { type: "done", run: run("error") });
    vi.advanceTimersByTime(60_000);
    expect(ctx.pet.state("thread").mood).toBe("error");
    ctx.emit("agent/event", "thread", { type: "run", run: run("running") });
    expect(ctx.pet.state("thread").mood).toBe("thinking");
    vi.useRealTimers();

    const current = ctx.settings.get();
    ctx.settings.set({ ...current, pet: { ...(current.pet as PetSettings), displayMode: "desktop" } });
    expect(contributions.accessories).toEqual([]);
    expect(surfaces.opened).toHaveLength(1);
    expect(surfaces.opened[0]).toMatchObject({ id: "tomrade.pet", transparent: true, alwaysOnTop: true });
    expect(surfaces.moves).toEqual([]);

    // Dragging is the only movement; a reopened window returns to where it was put.
    surfaces.opened[0].onMessage?.({ type: "move", x: 420, y: 260 });
    surfaces.opened[0].onMessage?.({ type: "move", x: Number.NaN, y: 0 });
    surfaces.opened[0].onMessage?.({ type: "reduced-motion", value: true });
    expect(surfaces.moves).toEqual([{ x: 420, y: 260 }]);
    ctx.settings.set({ ...ctx.settings.get(), pet: { ...(ctx.settings.get().pet as PetSettings), size: "large" } });
    expect(surfaces.opened).toHaveLength(2);
    expect(surfaces.closed).toBe(1);
    expect(surfaces.moves).toEqual([{ x: 420, y: 260 }, { x: 420, y: 260 }]);

    await first.dispose();
    expect(surfaces.closed).toBe(2);
    expect(ipc.handlers.has("pet.state")).toBe(false);
    expect(ctx.settings.sections().some((section) => section.id === "pet")).toBe(false);

    const second = await ctx.plugin(Pet);
    await settle();
    expect(surfaces.opened).toHaveLength(3);
    expect(ipc.handlers.has("pet.state")).toBe(true);
    await second.dispose();
    expect(surfaces.closed).toBe(3);
  });

  it("the active profile's images replace the pet's, with the built-in pet filling the rest", async () => {
    const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
    const ctx = new Context();
    await ctx.plugin(Settings, { path: path.join(dir, "profiles-settings.json") });
    await ctx.plugin(FakeAgent);
    await ctx.plugin(FakeContributions);
    await ctx.plugin(FakeIpc);
    await ctx.plugin(FakeSurfaces);
    await ctx.plugin(Pet, { profilesDir: path.join(dir, "pet-profiles") });
    await settle();
    const contributions = ctx.contributions as unknown as FakeContributions;
    const ipc = ctx.ipc as unknown as FakeIpc;
    const surfaces = ctx.desktopSurfaces as unknown as FakeSurfaces;
    const animations = () => contributions.accessories[0].animations;
    const builtInIdle = animations().idle.source;
    expect(builtInIdle).toMatch(/^data:image\/webp;base64,/);

    const mine = ipc.call("pet.createProfile", "Mochi") as PetProfileView;
    ipc.call("pet.setImage", mine.id, "idle", { base64: GIF.toString("base64") });
    expect(ipc.sent).toContain("pet.profilesChanged");
    // Editing a pet that is not showing leaves the one on screen alone.
    expect(contributions.accessories).toHaveLength(1);
    expect(animations().idle.source).toBe(builtInIdle);

    ipc.call("pet.activateProfile", mine.id);
    expect(contributions.accessories).toHaveLength(1);
    expect(animations().idle).toEqual({ source: `data:image/gif;base64,${GIF.toString("base64")}`, type: "image/gif" });
    expect(animations().working.source).toMatch(/^data:image\/webp;base64,/);
    const preview = ipc.call("pet.profilePreview", mine.id) as Record<PetMood, PetPreview>;
    expect([preview.idle.custom, preview.working.custom]).toEqual([true, false]);

    const current = ctx.settings.get();
    ctx.settings.set({ ...current, pet: { ...(current.pet as PetSettings), displayMode: "desktop" } });
    const desktop = () => (surfaces.states.at(-1) as { animation: { source: string; type: string } }).animation;
    expect(desktop()).toMatchObject({ type: "image/gif" });
    expect(desktop().source).toMatch(/^file:.*\/pet-profiles\/p-[a-f0-9]{8}\/idle-[a-z0-9]+\.gif$/);

    expect(() => ipc.call("pet.deleteProfile", "default")).toThrow(/built-in/);
    ipc.call("pet.deleteProfile", mine.id);
    expect(desktop().source).toMatch(/\/assets\/idle\.webp$/);
    expect((ipc.call("pet.profiles") as { active: string }).active).toBe("default");
  });

  it("the desktop pet follows the thread the panel shows, not the most urgent one anywhere", async () => {
    const ctx = new Context();
    await ctx.plugin(Settings, { path: path.join(dir, "follow-settings.json") });
    await ctx.plugin(FakeAgent);
    // An old thread still waiting for an answer, loaded when the app starts.
    (ctx.agent as unknown as FakeAgent).pending = [
      { threadId: "old", run: null, pending: { threadId: "old", kind: "ask", workflow: null, question: { id: "q", text: "Which ticket?" }, accepts: "text" } }
    ];
    await ctx.plugin(FakeContributions);
    await ctx.plugin(FakeIpc);
    await ctx.plugin(FakeSurfaces);
    await ctx.plugin(Pet);
    await settle();
    const surfaces = ctx.desktopSurfaces as unknown as FakeSurfaces;
    const current = ctx.settings.get();
    ctx.settings.set({ ...current, pet: { ...(current.pet as PetSettings), displayMode: "desktop" } });
    const desktop = () => surfaces.states.at(-1) as { mood: string; threadId: string | null };
    expect(desktop()).toMatchObject({ mood: "idle", threadId: null });

    ctx.emit("agent/showing", "now");
    ctx.emit("agent/event", "now", { type: "run", run: { ...run("running"), threadId: "now" } });
    expect(desktop()).toMatchObject({ mood: "thinking", threadId: "now" });
    ctx.emit("agent/event", "now", { type: "delta", runId: "run", text: "hi" });
    expect(desktop().mood).toBe("working");
    // Another thread's events leave the desktop pet alone.
    const before = surfaces.states.length;
    ctx.emit("agent/event", "elsewhere", { type: "done", run: { ...run("error"), id: "other", threadId: "elsewhere" } });
    expect(surfaces.states.length).toBe(before);
    ctx.emit("agent/showing", "old");
    expect(desktop()).toMatchObject({ mood: "waiting", threadId: "old" });
  });
});
