import { expect, it, vi } from "vitest";
import type { EngineView, LocalCliStatus } from "@tomradex/agent";
import { chainSteps, offersOfficial } from "../src/lib/setupChain";

// Only the chain's pure parts are under test; the hooks' screens and queries stay out.
vi.mock("../src/lib/setup", () => ({}));
vi.mock("../src/lib/queries", () => ({}));

const cli = (over: Partial<LocalCliStatus> = {}): LocalCliStatus => ({ name: "codebuddy", state: "ready", path: "/usr/local/bin/codebuddy", source: "path", attempts: [], searched: [], platform: "darwin", arch: "arm64", pathEnv: "", ...over });
const bundled = cli({ path: "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy", source: "known", insideApp: "WorkBuddy" });
const failed = { ok: false, ms: 10, at: 1, error: "session/new: internal error" };
const engine = (over: Partial<EngineView> = {}): EngineView => ({
  id: "codebuddy", title: "CodeBuddy", capabilities: ["backlog", "code", "general"], ok: true, cli: bundled,
  setup: { install: ["npm install -g @tencent-ai/codebuddy-code"] }, tried: failed, ...over
});

it("offers the official CLI when the test failed on a desktop app's own copy", () => {
  expect(offersOfficial(engine())).toBe(true);
  const [install, signIn, test] = chainSteps(engine(), null);
  expect(install).toMatchObject({ id: "install", state: "pending", official: true });
  expect(signIn).toMatchObject({ id: "sign-in", state: "done" });
  expect(test).toMatchObject({ id: "test", state: "pending" });
  // The run's own failed test counts the same before the engine is looked at again.
  expect(offersOfficial(engine({ tried: undefined }), failed)).toBe(true);
});

it("only retries when the CLI is not a desktop app's copy, has no install, or has not failed", () => {
  expect(offersOfficial(engine({ cli: cli() }))).toBe(false);
  expect(offersOfficial(engine({ setup: { install: [] } }))).toBe(false);
  expect(offersOfficial(engine({ tried: { ok: true, ms: 10, at: 1 } }))).toBe(false);
  expect(offersOfficial(engine({ tried: undefined }))).toBe(false);
  expect(chainSteps(engine({ cli: cli() }), null)[0]).toEqual({ id: "install", state: "done" });
});

it("ends a terminal-only agent's chain with a check it can pass", () => {
  const terminal = engine({ cli: cli(), capabilities: ["code", "general"], terminalOnly: true, tried: undefined });
  // Lending a model, its test is one answer from that model; lending none, being found and signed in is the check.
  expect(chainSteps({ ...terminal, asks: true }, null).map((s) => s.id)).toEqual(["install", "sign-in", "test"]);
  expect(chainSteps(terminal, null).at(-1)).toEqual({ id: "terminal", state: "done" });
  expect(chainSteps({ ...terminal, ok: false, need: "sign-in" }, null).at(-1)).toEqual({ id: "terminal", state: "pending" });
});
