import { describe, expect, it } from "vitest";
import { Triage, insertGate, reportLine, triageUser, type NightShift, type ShiftTicket } from "@tomradex/night-shift";

const ticket = (key: string, over: Partial<ShiftTicket> = {}) => ({ itemId: key, key, title: key, state: "running", ...over }) as ShiftTicket;
const shift = (tickets: ShiftTicket[], maxInserts?: number, over: Partial<NightShift> = {}) => ({ tickets, halt: null, settings: { maxInserts }, ...over }) as NightShift;

describe("whether a finding can join a run", () => {
  const added = ticket("X", { origin: { fromId: "A", fromKey: "A", why: "" } });

  it("can, within the limit", () => expect(insertGate(shift([ticket("A")], 3), ticket("A"), "coding", 0)).toBeNull());
  it("cannot when the person turned it off, or on a run from before there was a choice", () => {
    expect(insertGate(shift([ticket("A")], 0), ticket("A"), "coding", 0)).toBe("off");
    expect(insertGate(shift([ticket("A")]), ticket("A"), "coding", 0)).toBe("off");
  });
  it("counts what joined and what is on its way", () => {
    expect(insertGate(shift([ticket("A"), added], 1), ticket("A"), "coding", 0)).toBe("limit");
    expect(insertGate(shift([ticket("A"), added], 2), ticket("A"), "coding", 1)).toBe("limit");
    expect(insertGate(shift([ticket("A"), added], 3), ticket("A"), "coding", 1)).toBeNull();
  });
  it("is one level deep: what an added ticket finds waits for a person", () => expect(insertGate(shift([added], 3), added, "coding", 0)).toBe("nested"));
  it("takes coding work only", () => expect(insertGate(shift([ticket("A")], 3), ticket("A"), "general", 0)).toBe("not-coding"));
  it("takes nothing once the run is stopping", () => expect(insertGate(shift([ticket("A")], 3, { halt: "stopped" }), ticket("A"), "coding", 0)).toBe("halted"));
});

describe("what the worker model answers", () => {
  it("anything but a clear now is later", () => {
    expect(Triage.parse({ decision: "absolutely", why: 3 })).toEqual({ decision: "later", why: "" });
    expect(Triage.parse({ decision: "now", why: "It breaks export" })).toEqual({ decision: "now", why: "It breaks export" });
  });
  it("hears the finding, where it came from and what the run is doing", () => {
    const text = triageUser({ title: "Crash", body: "On save" }, ticket("A", { title: "Fix it" }), shift([ticket("A", { title: "Fix it" }), ticket("B")], 3), null);
    expect(text).toContain("FOUND WHILE WORKING ON A: Fix it");
    expect(text).toContain("Title: Crash");
    expect(text).toContain("- B (running)");
  });
});

it("tells an agent the tool, its own key, and to stay on its ticket", () => {
  const line = reportLine("TOM-1");
  expect(line).toContain("report_finding");
  expect(line).toContain('from: "TOM-1"');
  expect(line).toContain("go on with your own ticket");
});
