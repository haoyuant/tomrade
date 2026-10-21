import { expect, it } from "vitest";
import type { EnginePick, EngineView } from "@tomradex/agent";
import { engineHealth, engineProblem } from "../src/lib/engines";
import { firstRunSetup, setupState } from "../src/lib/setupState";

const models = (over: Partial<EnginePick> = {}): EnginePick => ({ key: "model", title: "Model", choices: [{ value: "m1" }], freeText: true, ...over });
const engine = (over: Partial<EngineView> = {}): EngineView => ({ id: "agent", title: "Agent", capabilities: ["backlog", "code", "general"], ok: true, picks: [models()], ...over });
const worker = { ok: true, via: "lent" as const, title: "Agent" };

it("counts a found agent as working once it listed its models", () => {
  expect(engineHealth(engine())).toBe("works");
  // Agents whose model list is not live (or that have no pick) work once found and signed in.
  expect(engineHealth(engine({ picks: [] }))).toBe("works");
  expect(engineHealth(engine({ picks: [models({ choices: [] })] }))).toBe("works");
});

it("does not count an agent that was found but could not list its models", () => {
  const broken = engine({ picks: [models({ choices: [], failed: "session/new: model not found" })] });
  expect(engineHealth(broken)).toBe("broken");
  expect(engineProblem(broken)).toEqual({ kind: "models", detail: "session/new: model not found" });
});

it("waits on an agent still listing its models", () => {
  expect(engineHealth(engine({ picks: [models({ choices: [], pending: true })] }))).toBe("checking");
});

it("lets a try with its current settings settle it either way", () => {
  const failedTry = { ok: false, ms: 10, at: 1, error: "model not found" };
  expect(engineHealth(engine({ tried: failedTry }))).toBe("broken");
  expect(engineProblem(engine({ tried: failedTry }))).toEqual({ kind: "tried", detail: "model not found" });
  const passed = engine({ tried: { ok: true, ms: 10, at: 1 }, picks: [models({ choices: [], failed: "timed out" })] });
  expect(engineHealth(passed)).toBe("works");
  expect(engineProblem(passed)).toBeNull();
});

it("leaves an agent that is not ready to its own state", () => {
  const signedOut = engine({ ok: false, need: "sign-in" });
  expect(engineHealth(signedOut)).toBe("broken");
  expect(engineProblem(signedOut)).toBeNull();
});

it("completes setup only with a working assistant and a worker", () => {
  expect(setupState([engine()], worker)).toMatchObject({ complete: true, checking: false });
  expect(setupState([engine()], { ok: false, reason: "none" }).complete).toBe(false);
  const broken = setupState([engine({ picks: [models({ choices: [], failed: "model not found" })] })], worker);
  expect(broken).toMatchObject({ complete: false, checking: false, assistant: [], locals: [] });
  expect(setupState([engine({ picks: [models({ choices: [], pending: true })] })], worker)).toMatchObject({ complete: false, checking: true });
  // One working agent is enough, whatever the others are doing.
  expect(setupState([engine({ id: "a", picks: [models({ choices: [], failed: "x" })] }), engine({ id: "b" })], worker)).toMatchObject({ complete: true, checking: false });
});

it("counts a worker profile only once its one-token test answered", () => {
  const viaProfile = { ok: true, via: "profile" as const, title: "DeepSeek" };
  // Unasked or still answering: the screen waits rather than deciding.
  expect(setupState([engine()], viaProfile)).toMatchObject({ complete: false, checking: true });
  expect(setupState([engine()], viaProfile, "pending")).toMatchObject({ complete: false, checking: true });
  expect(setupState([engine()], viaProfile, { ok: false })).toMatchObject({ complete: false, checking: false });
  expect(setupState([engine()], viaProfile, { ok: true })).toMatchObject({ complete: true, checking: false });
  // A lent model proved itself through its agent: no test is asked of it.
  expect(setupState([engine()], worker)).toMatchObject({ complete: true, checking: false });
});

it("opens the first-run setup for an agent that was found but cannot run, and skips it for one that works", () => {
  const notSeen = { seen: false, waited: false };
  expect(firstRunSetup({ complete: false, checking: false }, notSeen)).toBe("open");
  expect(firstRunSetup({ complete: true, checking: false }, notSeen)).toBe("closed");
  // Dealt with once, it does not come back by itself.
  expect(firstRunSetup({ complete: false, checking: false }, { seen: true, waited: false })).toBe("closed");
  // An agent still listing its models gets a moment before the screen decides.
  expect(firstRunSetup({ complete: false, checking: true }, notSeen)).toBeNull();
  expect(firstRunSetup({ complete: false, checking: true }, { seen: false, waited: true })).toBe("open");
});
