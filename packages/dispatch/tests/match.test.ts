import { describe, expect, it } from "vitest";
import { match, unfit, type MatchDevice } from "../src/match.js";

const accept = { on: true, projects: "all" as const, concurrent: 1 };
const device = (id: string, over: Partial<MatchDevice> = {}): MatchDevice => ({
  id, name: id, self: false, online: true, platform: "win32", agents: [{ id: "claude-code", ready: true }], repos: [], accept, sessions: [], ...over
});
const mac = device("mac", { self: true, platform: "darwin", name: "Studio" });
const win = device("win", { name: "Windows tower" });
const ticket = (labels: string[] = [], remote: string | null = "https://github.com/acme/app") => ({ projectId: "p1", labels, remote });

describe("where a ticket should run", () => {
  it("stays here when nothing says otherwise", () => {
    expect(match(ticket(), [mac, win])).toEqual({ kind: "here", by: "none" });
    expect(match(ticket(["bug", "ui"]), [mac, win])).toEqual({ kind: "here", by: "none" });
    expect(match(ticket(), [])).toEqual({ kind: "here", by: "none" });
  });

  it("a ticket labelled windows, planned on a Mac, goes to the Windows machine", () => {
    expect(match(ticket(["Windows"]), [mac, win])).toEqual({ kind: "send", device: "win", name: "Windows tower", by: "label", clone: true });
    // On the Windows machine itself, it stays.
    expect(match(ticket(["windows"]), [{ ...win, self: true }, { ...mac, self: false }])).toEqual({ kind: "here", by: "label" });
    expect(match(ticket(["macos"]), [mac, win])).toEqual({ kind: "here", by: "label" });
  });

  it("among machines of the platform, takes one that has the repository, then the least busy", () => {
    const has = device("w2", { name: "Has it", repos: ["git@github.com:Acme/App.git"], accept: { ...accept, concurrent: 3 }, sessions: [{}, {}] });
    const idle = device("w3", { name: "Idle" });
    expect(match(ticket(["windows"]), [mac, idle, has])).toMatchObject({ kind: "send", device: "w2", clone: false });
    const busier = device("w4", { name: "Busier", accept: { ...accept, concurrent: 3 }, sessions: [{}] });
    expect(match(ticket(["windows"]), [mac, busier, idle])).toMatchObject({ kind: "send", device: "w3", clone: true });
    expect(match(ticket(["windows"], null), [mac, device("b", { name: "B" }), device("a", { name: "A" })])).toMatchObject({ device: "a" });
  });

  it("waits for the right machine when it is off or full, preferring one that is on", () => {
    expect(match(ticket(["windows"]), [mac, { ...win, online: false }])).toEqual({ kind: "wait", device: "win", name: "Windows tower", by: "label", why: "offline" });
    expect(match(ticket(["windows"]), [mac, { ...win, sessions: [{}] }])).toEqual({ kind: "wait", device: "win", name: "Windows tower", by: "label", why: "busy" });
    expect(match(ticket(["windows"]), [mac, device("off", { online: false }), device("full", { sessions: [{}] })])).toMatchObject({ kind: "wait", device: "full", why: "busy" });
    // One that can take it now beats both.
    expect(match(ticket(["windows"]), [mac, device("off", { online: false }), device("ok")])).toMatchObject({ kind: "send", device: "ok" });
  });

  it("says why when no machine of the platform can take it, and leaves it here", () => {
    expect(match(ticket(["windows"]), [mac])).toEqual({ kind: "none", by: "label", wanted: "windows", why: "nobody" });
    expect(match(ticket(["linux"]), [mac, win])).toEqual({ kind: "none", by: "label", wanted: "linux", why: "nobody" });
    expect(match(ticket(["windows"]), [mac, { ...win, accept: { ...accept, on: false } }])).toEqual({ kind: "none", by: "label", wanted: "windows", why: "not-accepting", name: "Windows tower" });
    expect(match(ticket(["windows"]), [mac, { ...win, accept: undefined }])).toMatchObject({ kind: "none", why: "not-accepting" });
    expect(match(ticket(["windows"]), [mac, { ...win, accept: { ...accept, projects: ["p2"] } }])).toMatchObject({ kind: "none", why: "project" });
    expect(match(ticket(["windows"]), [mac, { ...win, agents: [{ id: "codex", ready: false }] }])).toMatchObject({ kind: "none", why: "no-agent" });
    expect(match(ticket(["windows"]), [mac, { ...win, agents: [] }])).toMatchObject({ kind: "none", why: "no-agent" });
  });

  it("a ticket that names one machine goes to it, waits for it, or says why not", () => {
    expect(match(ticket(["device:Windows Tower"]), [mac, win])).toEqual({ kind: "send", device: "win", name: "Windows tower", by: "label", clone: true });
    expect(match(ticket(["device:studio"]), [mac, win])).toEqual({ kind: "here", by: "label" });
    expect(match(ticket(["device:windows tower"]), [mac, { ...win, online: false }])).toMatchObject({ kind: "wait", why: "offline" });
    expect(match(ticket(["device:gone"]), [mac, win])).toEqual({ kind: "none", by: "label", wanted: "gone", why: "nobody" });
    expect(match(ticket(["device:windows tower"]), [mac, { ...win, accept: { ...accept, on: false } }])).toEqual({ kind: "none", by: "label", wanted: "windows tower", why: "not-accepting", name: "Windows tower" });
    // The machine it names beats the platform it also names.
    expect(match(ticket(["macos", "device:windows tower"]), [mac, win])).toMatchObject({ kind: "send", device: "win" });
  });

  it("a project's rules keep work away from a machine, by its name or its id", () => {
    expect(match(ticket(["windows"]), [mac, win], { excluded: ["windows TOWER"] })).toEqual({ kind: "none", by: "label", wanted: "windows", why: "excluded", name: "Windows tower" });
    expect(match(ticket(["windows"]), [mac, win, device("w2", { name: "Laptop" })], { excluded: ["win"] })).toMatchObject({ kind: "send", device: "w2" });
    expect(match(ticket(["device:windows tower"]), [mac, win], { excluded: ["Windows tower"] })).toMatchObject({ kind: "none", why: "excluded" });
  });

  it("hears a model only where no label speaks, and only for a machine the rules allow", () => {
    expect(match(ticket(), [mac, win], { model: "windows tower" })).toEqual({ kind: "send", device: "win", name: "Windows tower", by: "model", clone: true });
    expect(match(ticket(), [mac, win], { model: "win" })).toMatchObject({ kind: "send", by: "model" });
    // A label outranks it.
    expect(match(ticket(["macos"]), [mac, win], { model: "Windows tower" })).toEqual({ kind: "here", by: "label" });
    expect(match(ticket(["windows"]), [mac, win, device("w2", { name: "Laptop", repos: ["https://github.com/acme/app"] })], { model: "Windows tower" })).toMatchObject({ device: "w2", by: "label" });
    // A machine it made up, this machine, one that is off, full, excluded or not accepting: here.
    for (const [model, devices, excluded] of [
      ["Nowhere", [mac, win], []], ["Studio", [mac, win], []], ["Windows tower", [mac, { ...win, online: false }], []], ["Windows tower", [mac, { ...win, sessions: [{}] }], []],
      ["Windows tower", [mac, win], ["Windows tower"]], ["Windows tower", [mac, { ...win, accept: { ...accept, on: false } }], []]
    ] as const) expect(match(ticket(), devices, { model, excluded })).toEqual({ kind: "here", by: "none" });
    expect(match(ticket(), [mac, win], { model: null })).toEqual({ kind: "here", by: "none" });
  });
});

it("says the first thing that keeps a machine from taking a ticket", () => {
  expect(unfit(win, "p1")).toBeNull();
  expect(unfit({ ...win, online: false, accept: { ...accept, on: false } }, "p1")).toBe("not-accepting");
  expect(unfit({ ...win, online: false, sessions: [{}] }, "p1")).toBe("offline");
  expect(unfit({ ...win, accept: { ...accept, concurrent: 2 }, sessions: [{}] }, "p1")).toBeNull();
});
