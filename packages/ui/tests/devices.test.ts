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
