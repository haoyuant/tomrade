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
