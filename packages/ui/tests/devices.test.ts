import { expect, it } from "vitest";
import type { DeviceSession, DeviceView } from "@tomradex/hub-cloud";
import { elsewhereOn } from "../src/lib/devices";

const session = (key: string, state: DeviceSession["state"] = "working"): DeviceSession => ({ projectId: "p1", key, title: key, agent: "claude-code", state, startedAt: 1, branch: null });
const device = (id: string, over: Partial<DeviceView>): DeviceView => ({
  id, name: id, self: false, online: true, lastSeenAt: 0, activityAt: 10, platform: "win32", arch: "x64", version: "1.0.0", git: true, agents: [], repos: [], sessions: [], nightShifts: [], ...over
});

it("finds the other machine that holds a ticket, never this one", () => {
  const devices = [
    device("self", { self: true, sessions: [session("TOM-1")] }),
    device("win", { sessions: [session("TOM-1", "waiting"), session("TOM-2")] })
  ];
  expect(elsewhereOn(devices, "p1", "TOM-1")).toMatchObject({ device: { id: "win" }, session: { state: "waiting" } });
  expect(elsewhereOn(devices, "p1", "TOM-3")).toBeNull();
  // The same key in another project is another ticket.
  expect(elsewhereOn(devices, "p2", "TOM-1")).toBeNull();
  expect(elsewhereOn(undefined, "p1", "TOM-1")).toBeNull();
  expect(elsewhereOn([device("self", { self: true, sessions: [session("TOM-1")] })], "p1", "TOM-1")).toBeNull();
});

it("prefers a machine that is on, then the one that said so last", () => {
  const off = device("old", { online: false, activityAt: 50, sessions: [session("TOM-1")] });
  const older = device("older", { online: false, activityAt: 20, sessions: [session("TOM-1")] });
  const on = device("on", { online: true, activityAt: 5, sessions: [session("TOM-1")] });
  expect(elsewhereOn([older, off, on], "p1", "TOM-1")?.device.id).toBe("on");
  expect(elsewhereOn([older, off], "p1", "TOM-1")?.device.id).toBe("old");
});

import { dispatchOf, targetOf, takers } from "../src/lib/devices";

it("offers a ticket only the other computers that accept work for its project", () => {
  const accept = { on: true, projects: "all" as const, ceiling: "edits" as const, concurrent: 1 };
  const devices = [
    device("self", { self: true, accept }),
    device("win", { accept }),
    device("off", { accept: { ...accept, on: false } }),
    device("picky", { accept: { ...accept, projects: ["p2"] } }),
    device("silent", {})
  ];
  expect(takers(devices, "p1").map((d) => d.id)).toEqual(["win"]);
  expect(takers(devices, "p2").map((d) => d.id)).toEqual(["win", "picky"]);
  expect(takers(undefined, "p1")).toEqual([]);
});

it("reads where a ticket should run from its labels: one computer by name, or any of a platform", () => {
  const accept = { on: true, projects: "all" as const, ceiling: "edits" as const, concurrent: 1 };
  const able = [device("w1", { name: "Windows Tower", platform: "win32", accept }), device("m1", { name: "Studio", platform: "darwin", accept })];
  expect(targetOf({ labels: ["bug", "Device:windows tower"] }, able)).toBe("w1");
  expect(targetOf({ labels: ["windows"] }, able)).toBe("platform:win32");
  expect(targetOf({ labels: ["macOS", "windows"] }, able)).toBe("platform:darwin");
  // A computer that cannot take it, or a platform nobody has, leaves the ticket here.
  expect(targetOf({ labels: ["device:gone"] }, able)).toBeNull();
  expect(targetOf({ labels: ["linux"] }, able)).toBeNull();
  expect(targetOf({ labels: [] }, able)).toBeNull();
});

it("finds the newest request for a ticket", () => {
  const row = (id: string, key: string, projectId = "p1") => ({ id, key, projectId }) as never;
  expect(dispatchOf([row("new", "TOM-1"), row("old", "TOM-1"), row("x", "TOM-2")], "p1", "TOM-1")).toMatchObject({ id: "new" });
  expect(dispatchOf([row("x", "TOM-1", "p2")], "p1", "TOM-1")).toBeNull();
  expect(dispatchOf(undefined, "p1", "TOM-1")).toBeNull();
});

import type { DevicesInfo } from "@tomradex/hub-cloud";
import { runOnState } from "../src/lib/devices";

it("says what Start's choice of computer lacks: an account, a second computer, a place, or one that takes the ticket", () => {
  const accept = { on: true, projects: "all" as const, ceiling: "edits" as const, concurrent: 1 };
  const info = (state: DevicesInfo["state"], devices: DeviceView[] = []): DevicesInfo => ({ state, devices, plan: { id: "free", limit: 2, subscribeUrl: "" } });
  const self = device("self", { self: true, accept });
  // No account service, or nothing read yet, or still registering: nothing to say, and no wrong word in the meantime.
  expect(runOnState(false, info("ready", [self]), "p1")).toEqual({ kind: "hidden" });
  expect(runOnState(undefined, undefined, "p1")).toEqual({ kind: "hidden" });
  expect(runOnState(true, undefined, "p1")).toEqual({ kind: "hidden" });
  expect(runOnState(true, info("pending", [self]), "p1")).toEqual({ kind: "hidden" });
  expect(runOnState(true, info("signed-out"), "p1")).toEqual({ kind: "signed-out" });
  expect(runOnState(true, info("ready", [self]), "p1")).toEqual({ kind: "alone" });
  // A computer with no place among the account's is not asked to sign in: it is signed in.
  expect(runOnState(true, info("removed"), "p1")).toEqual({ kind: "out" });
  expect(runOnState(true, info("over-limit", [device("a", {}), device("b", {})]), "p1")).toEqual({ kind: "out" });

  const others = [device("win", { accept }), device("off", { accept: { ...accept, on: false } }), device("picky", { accept: { ...accept, projects: ["p2"] } }), device("silent", {})];
  const chosen = runOnState(true, info("ready", [self, ...others]), "p1");
  expect(chosen.kind === "choose" && chosen.others.map((o) => [o.device.id, o.why])).toEqual([["win", null], ["off", "not-accepting"], ["picky", "project"], ["silent", "not-accepting"]]);
  // None can take it: they are still listed, each with why.
  const none = runOnState(true, info("ready", [self, ...others.slice(1)]), "p1");
  expect(none.kind === "choose" && none.others.every((o) => o.why)).toBe(true);
});

import { labelMiss } from "../src/lib/devices";

it("says why a label's computer cannot take a ticket, by the rules that place tickets", () => {
  const accept = { on: true, projects: "all" as const, ceiling: "edits" as const, concurrent: 1 };
  const ready = [{ id: "claude-code", title: "Claude Code", ready: true }];
  const info = (devices: DeviceView[], state: DevicesInfo["state"] = "ready"): DevicesInfo => ({ state, devices, plan: { id: "free", limit: 2, subscribeUrl: "" } });
  const self = device("self", { self: true, name: "Studio", platform: "darwin", accept, agents: ready });
  const win = (over: Partial<DeviceView> = {}) => device("win", { name: "Tower", platform: "win32", accept, agents: ready, ...over });
  const miss = (labels: string[], devices: DeviceView[]) => labelMiss({ labels }, "p1", info(devices));

  // A platform nobody has, and a name nobody has.
  expect(miss(["windows"], [self])).toEqual({ label: "windows", platform: "win32", name: "windows", why: "nobody" });
  expect(miss(["Device:Gone"], [self, win()])).toEqual({ label: "device:gone", platform: null, name: "gone", why: "nobody" });
  // The one the label asks for, and why it cannot: by platform and by name alike.
  expect(miss(["windows"], [self, win({ accept: { ...accept, on: false } })])).toMatchObject({ platform: "win32", name: "Tower", why: "not-accepting" });
  expect(miss(["windows"], [self, win({ accept: undefined })])).toMatchObject({ name: "Tower", why: "not-accepting" });
  expect(miss(["windows"], [self, win({ accept: { ...accept, projects: ["p2"] } })])).toMatchObject({ name: "Tower", why: "project" });
  expect(miss(["windows"], [self, win({ agents: [{ id: "codex", title: "Codex", ready: false }] })])).toMatchObject({ name: "Tower", why: "no-agent" });
  expect(miss(["device:tower"], [self, win({ accept: { ...accept, on: false } })])).toEqual({ label: "device:tower", platform: null, name: "Tower", why: "not-accepting" });

  // Off or full only has to wait: it can still be sent there.
  expect(miss(["windows"], [self, win({ online: false })])).toBeNull();
  expect(miss(["windows"], [self, win({ sessions: [session("TOM-9")] })])).toBeNull();
  // It can take it; the label means this computer; or no label speaks of where.
  expect(miss(["windows"], [self, win()])).toBeNull();
  expect(miss(["macos"], [self, win()])).toBeNull();
  expect(miss(["device:studio"], [self])).toBeNull();
  expect(miss(["bug"], [self])).toBeNull();
  // Before this computer has its place, nothing is known of the others: nothing is said.
  expect(labelMiss({ labels: ["windows"] }, "p1", info([], "signed-out"))).toBeNull();
  expect(labelMiss({ labels: ["windows"] }, "p1", info([self], "pending"))).toBeNull();
  expect(labelMiss({ labels: ["windows"] }, "p1", undefined)).toBeNull();
});
