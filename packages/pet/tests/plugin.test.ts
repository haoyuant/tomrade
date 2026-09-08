import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Context, Service } from "cordis";
import type { AgentActivity, RunView } from "@tomrade/agent";
import type { AssistantAccessory } from "@tomrade/contributions";
import type { DesktopSurface, DesktopSurfaceSpec, SurfaceBounds } from "@tomrade/desktop-surface";
import { Settings } from "@tomrade/settings";
import { Pet, type PetSettings } from "@tomrade/pet";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pet-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

class FakeAgent extends Service {
  static provide = "agent";
  activities(): AgentActivity[] {
    return [];
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
  send() {}
}

class FakeSurfaces extends Service {
  static provide = "desktopSurfaces";
  opened: DesktopSurfaceSpec[] = [];
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
      setPosition: (x, y) => Object.assign(bounds, { x, y }),
      setState: () => {},
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
    vi.useFakeTimers();
    ctx.emit("agent/event", "thread", { type: "done", run: run("done") });
    expect(ctx.pet.state("thread").mood).toBe("success");
    vi.advanceTimersByTime(2_600);
    expect(ctx.pet.state("thread").mood).toBe("idle");
    vi.useRealTimers();

    const current = ctx.settings.get();
    ctx.settings.set({ ...current, pet: { ...(current.pet as PetSettings), displayMode: "desktop", roam: false } });
    expect(contributions.accessories).toEqual([]);
    expect(surfaces.opened).toHaveLength(1);
    expect(surfaces.opened[0]).toMatchObject({ id: "tomrade.pet", transparent: true, alwaysOnTop: true });

    await first.dispose();
    expect(surfaces.closed).toBe(1);
    expect(ipc.handlers.has("pet.state")).toBe(false);
    expect(ctx.settings.sections().some((section) => section.id === "pet")).toBe(false);

    const second = await ctx.plugin(Pet);
    await settle();
    expect(surfaces.opened).toHaveLength(2);
    expect(ipc.handlers.has("pet.state")).toBe(true);
    await second.dispose();
    expect(surfaces.closed).toBe(2);
  });
});
