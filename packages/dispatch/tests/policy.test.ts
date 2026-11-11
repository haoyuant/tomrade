import { describe, expect, it } from "vitest";
import { AcceptPolicy, IDLE_SECONDS, POLICY_DEFAULTS, admit, levelOf, modeWithin, published, type MachineState } from "../src/policy.js";

const on = (over: Partial<AcceptPolicy> = {}): AcceptPolicy => AcceptPolicy.parse({ accept: true, ...over });
const request = { from: "mac-0001", projectId: "p1", key: "TOM-1" };
const state = (over: Partial<MachineState> = {}): MachineState => ({ projects: ["p1", "p2"], running: 0, idleSeconds: 10_000, onBattery: false, ...over });
const CLAUDE = ["auto", "bypassPermissions", "acceptEdits", "default", "plan", "local"];
const CODEX = ["full-access", "workspace", "read-only", "local"];

describe("whether a machine takes a request", () => {
  it("takes nothing until the person turns it on", () => {
    expect(POLICY_DEFAULTS.accept).toBe(false);
    expect(admit(POLICY_DEFAULTS, request, state())).toEqual({ ok: false, reason: "off" });
    // Off wins over everything a request could say.
    expect(admit(AcceptPolicy.parse({ accept: false, ceiling: "full" }), { ...request, permissionMode: "plan" }, state())).toEqual({ ok: false, reason: "off" });
  });

  it("takes a ticket of a project it has, and leaves the mode to the engine's best within the limit", () => {
    expect(admit(on(), request, state())).toEqual({ ok: true, permissionMode: null });
    expect(admit(on(), request, state({ modes: CLAUDE }))).toEqual({ ok: true, permissionMode: "acceptEdits" });
    expect(admit(on(), request, state({ modes: CODEX }))).toEqual({ ok: true, permissionMode: "workspace" });
    expect(admit(on({ ceiling: "full" }), request, state({ modes: CLAUDE }))).toMatchObject({ ok: true });
    expect(admit(on({ ceiling: "read" }), request, state({ modes: CLAUDE }))).toEqual({ ok: true, permissionMode: "plan" });
  });

  it("turns away a project outside the ones it named, and one it does not have, saying which", () => {
    expect(admit(on({ allProjects: false, projects: ["p2"] }), request, state())).toEqual({ ok: false, reason: "project-not-allowed" });
    expect(admit(on({ allProjects: false, projects: ["p1"] }), request, state())).toMatchObject({ ok: true });
    expect(admit(on({ allProjects: false, projects: [] }), request, state())).toEqual({ ok: false, reason: "project-not-allowed" });
    expect(admit(on(), { ...request, projectId: "p9" }, state())).toEqual({ ok: false, reason: "project-missing" });
  });

  it("turns away a permission mode above its limit rather than lowering it, and says why", () => {
    expect(admit(on(), { ...request, permissionMode: "bypassPermissions" }, state({ modes: CLAUDE }))).toEqual({ ok: false, reason: "permission", detail: "bypassPermissions is above this machine's limit (edits)" });
    expect(admit(on(), { ...request, permissionMode: "full-access" }, state())).toMatchObject({ ok: false, reason: "permission" });
    expect(admit(on(), { ...request, permissionMode: "auto" }, state())).toMatchObject({ ok: false, reason: "permission" });
    // Full access only where the person chose it.
    expect(admit(on({ ceiling: "full" }), { ...request, permissionMode: "bypassPermissions" }, state({ modes: CLAUDE }))).toEqual({ ok: true, permissionMode: "bypassPermissions" });
    // Within the limit, what was asked is what runs.
    expect(admit(on(), { ...request, permissionMode: "default" }, state({ modes: CLAUDE }))).toEqual({ ok: true, permissionMode: "default" });
    // A mode nobody knows counts as full; one the engine here does not have is not run at all.
    expect(admit(on(), { ...request, permissionMode: "yolo" }, state())).toMatchObject({ ok: false, reason: "permission" });
    expect(admit(on({ ceiling: "full" }), { ...request, permissionMode: "yolo" }, state({ modes: CLAUDE }))).toEqual({ ok: false, reason: "permission", detail: "yolo is not a mode of the agent here" });
    // An engine with nothing within the limit.
    expect(admit(on({ ceiling: "read" }), request, state({ modes: ["full-access"] }))).toMatchObject({ ok: false, reason: "permission" });
  });

  it("turns away what would go past its sessions at once, and waits for idle or power when asked to", () => {
    expect(admit(on(), request, state({ running: 1 }))).toEqual({ ok: false, reason: "busy", detail: "1 of 1 running" });
    expect(admit(on({ maxConcurrent: 2 }), request, state({ running: 1 }))).toMatchObject({ ok: true });
    expect(admit(on({ onlyWhenIdle: true }), request, state({ idleSeconds: IDLE_SECONDS - 1 }))).toEqual({ ok: false, reason: "not-idle" });
    expect(admit(on({ onlyWhenIdle: true }), request, state({ idleSeconds: IDLE_SECONDS }))).toMatchObject({ ok: true });
    expect(admit(on(), request, state({ idleSeconds: 0, onBattery: true }))).toMatchObject({ ok: true });
    expect(admit(on({ onlyOnPower: true }), request, state({ onBattery: true }))).toEqual({ ok: false, reason: "on-battery" });
  });
});

it("ranks each engine's modes, and counts an unknown one as the most", () => {
  expect([levelOf("plan"), levelOf("read-only"), levelOf("default"), levelOf("local"), levelOf("acceptEdits"), levelOf("workspace"), levelOf("auto"), levelOf("bypassPermissions"), levelOf("full-access"), levelOf("made-up")])
    .toEqual(["read", "read", "ask", "ask", "edits", "edits", "full", "full", "full", "full"]);
  expect(modeWithin("ask", CLAUDE)).toBe("default");
  expect(modeWithin("read", ["full-access"])).toBeNull();
});

it("tells the other machines only whether it takes work and within what", () => {
  expect(published(POLICY_DEFAULTS)).toEqual({ on: false, projects: "all", ceiling: "edits", concurrent: 1 });
  expect(published(on({ allProjects: false, projects: ["p2", "p1"], ceiling: "full", maxConcurrent: 3, onlyWhenIdle: true }))).toEqual({ on: true, projects: ["p1", "p2"], ceiling: "full", concurrent: 3 });
  // Off: which projects it once named is nobody's business.
  expect(published(AcceptPolicy.parse({ accept: false, allProjects: false, projects: ["p1"] }))).toMatchObject({ on: false, projects: "all" });
});
