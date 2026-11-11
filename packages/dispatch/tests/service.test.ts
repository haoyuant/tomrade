import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { Settings } from "@tomradex/settings";
import { fresh, settle } from "@tomradex/testkit";
import { Dispatch, type DispatchDecision } from "@tomradex/dispatch";

const dirs: string[] = [];
const contexts: { fiber: { dispose(): Promise<unknown> } }[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(opts: { dir?: string; machine?: { idle: number; battery: boolean } } = {}) {
  const dir = opts.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-dispatch-"));
  if (!opts.dir) dirs.push(dir);
  const machine = opts.machine ?? { idle: 10_000, battery: false };
  const f = await fresh({ plugins: [[Settings, { path: path.join(dir, "settings.json") }]] });
  contexts.push(f.ctx);
  // What the account service is told, and when it is asked to register again.
  const cloud = { said: null as (() => unknown) | null, refreshed: 0 };
  f.ctx.provide("cloudHub", { describeDevice: (_part: string, read: () => unknown) => { cloud.said = read; }, refreshDevice: () => { cloud.refreshed++; } } as never);
  await f.ctx.plugin(Dispatch, { logFile: path.join(dir, "dispatch-log.json"), idleSeconds: () => machine.idle, onBattery: () => machine.battery });
  await settle();
  const decided: DispatchDecision[] = [];
  f.ctx.on("dispatch/decided", (d) => { decided.push(d); });
  const set = (dispatch: Record<string, unknown>) => f.ctx.settings.set({ ...f.ctx.settings.get(), dispatch } as never);
  return { ...f, dir, s: f.ctx.dispatch, cloud, decided, set, machine };
}

it("is off by default, is the machine's own setting, and says what turning it on means", async () => {
  const t = await boot();
  expect(t.s.policy()).toMatchObject({ accept: false, allProjects: true, ceiling: "edits", maxConcurrent: 1 });
  const section = t.ctx.settings.sections().find((s) => s.id === "dispatch")!;
  expect(section).toMatchObject({ scope: "machine" });
  expect(section.description).toMatch(/an agent runs here and changes code here/);
  expect(t.s.admit({ from: "mac-0001", projectId: t.project.id, key: "TOM-1" })).toEqual({ ok: false, reason: "off" });
});

it("decides by this machine's settings whatever the request says, and keeps each decision with who asked", async () => {
  const t = await boot();
  t.set({ accept: true });
  const mine = { from: "mac-0001", projectId: t.project.id, key: "TOM-1" };
  expect(t.s.admit(mine, ["bypassPermissions", "acceptEdits", "default"])).toEqual({ ok: true, permissionMode: "acceptEdits" });
  // A request that claims more than this machine allows, with fields no request has.
  expect(t.s.admit({ ...mine, key: "TOM-2", permissionMode: "bypassPermissions", ceiling: "full", accept: true, maxConcurrent: 99 } as never)).toMatchObject({ ok: false, reason: "permission" });
  expect(t.s.admit({ ...mine, projectId: "not-here", key: "ZZ-9" })).toEqual({ ok: false, reason: "project-missing" });
  t.set({ accept: true, allProjects: false, projects: ["another"] });
  expect(t.s.admit(mine)).toEqual({ ok: false, reason: "project-not-allowed" });

  expect(t.s.recent()).toMatchObject([
    { from: "mac-0001", key: "TOM-1", accepted: false, reason: "project-not-allowed" },
    { from: "mac-0001", key: "ZZ-9", projectId: "not-here", accepted: false, reason: "project-missing" },
    { from: "mac-0001", key: "TOM-2", accepted: false, reason: "permission", detail: "bypassPermissions is above this machine's limit (edits)" },
    { from: "mac-0001", key: "TOM-1", accepted: true, permissionMode: "acceptEdits" }
  ]);
  expect(t.decided).toHaveLength(4);
  expect(t.s.recent().every((d) => typeof d.at === "number" && d.at > 0)).toBe(true);
});

it("counts the sessions it runs for others, and reads idle and power from the machine", async () => {
  const t = await boot();
  t.set({ accept: true, onlyWhenIdle: true, onlyOnPower: true });
  const mine = { from: "mac-0001", projectId: t.project.id, key: "TOM-1" };
  expect(t.s.admit(mine)).toMatchObject({ ok: true });
  t.s.began("d1");
  expect(t.s.admit(mine)).toMatchObject({ ok: false, reason: "busy" });
  t.s.ended("d1");
  t.machine.idle = 5;
  expect(t.s.admit(mine)).toEqual({ ok: false, reason: "not-idle" });
  t.machine.idle = 10_000;
  t.machine.battery = true;
  expect(t.s.admit(mine)).toEqual({ ok: false, reason: "on-battery" });
});

it("turned off again, it takes nothing more", async () => {
  const t = await boot();
  t.set({ accept: true });
  const mine = { from: "mac-0001", projectId: t.project.id, key: "TOM-1" };
  expect(t.s.admit(mine)).toMatchObject({ ok: true });
  t.s.began("d1");
  t.set({ accept: false });
  expect(t.s.admit({ ...mine, key: "TOM-2" })).toEqual({ ok: false, reason: "off" });
  // Settings refuse a value that is not a yes or a no, and it stays off.
  expect(() => t.set({ accept: "yes" })).toThrow(/dispatch\.accept/);
  expect(t.s.admit(mine)).toEqual({ ok: false, reason: "off" });
});

it("tells the account's other machines whether it takes work, and again when that changes", async () => {
  const t = await boot();
  expect(t.cloud.said?.()).toEqual({ on: false, projects: "all", ceiling: "edits", concurrent: 1 });
  const before = t.cloud.refreshed;
  t.set({ accept: true, ceiling: "full", maxConcurrent: 2 });
  expect(t.cloud.refreshed).toBe(before + 1);
  expect(t.cloud.said?.()).toEqual({ on: true, projects: "all", ceiling: "full", concurrent: 2 });
  // Another section changing says nothing about this one.
  t.ctx.settings.set({ ...t.ctx.settings.get(), theme: "dark" });
  expect(t.cloud.refreshed).toBe(before + 1);
});

it("keeps the record across a restart, on this machine only", async () => {
  const t = await boot();
  t.set({ accept: true });
  t.s.admit({ from: "mac-0001", projectId: t.project.id, key: "TOM-1" });
  t.s.admit({ from: "win-0001", projectId: "not-here", key: "ZZ-9" });
  contexts.splice(contexts.indexOf(t.ctx), 1);
  await t.ctx.fiber.dispose();
  const again = await boot({ dir: t.dir });
  expect(again.s.recent().map((d) => [d.from, d.key, d.accepted])).toEqual([["win-0001", "ZZ-9", false], ["mac-0001", "TOM-1", true]]);
  expect(fs.statSync(path.join(t.dir, "dispatch-log.json")).mode & 0o777).toBe(0o600);
});
