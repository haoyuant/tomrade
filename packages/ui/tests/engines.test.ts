import { expect, it } from "vitest";
import type { LocalCliStatus } from "@tomradex/agent";
import { detectedHere } from "../src/lib/engines";

const cli = (over: Partial<LocalCliStatus>): LocalCliStatus => ({ name: "x", state: "missing", attempts: [], searched: [], platform: "darwin", arch: "arm64", pathEnv: "", ...over });

it("lists an engine whose CLI is on this machine, whatever state it is in", () => {
  expect(detectedHere({ ok: true, cli: cli({ state: "ready" }) })).toBe(true);
  expect(detectedHere({ ok: false, need: "sign-in", cli: cli({ state: "ready" }) })).toBe(true);
  expect(detectedHere({ ok: false, need: "repair", cli: cli({ state: "broken" }) })).toBe(true);
});

it("keeps a found-but-unusable CLI and a hand-picked path in view, since the row says what to do", () => {
  expect(detectedHere({ ok: false, need: "install", cli: cli({ wsl: "/home/me/bin/codex" }) })).toBe(true);
  expect(detectedHere({ ok: false, need: "install", cli: cli({ desktopApp: "/Applications/Cursor.app" }) })).toBe(true);
  expect(detectedHere({ ok: false, need: "install", cli: cli({ manual: { path: "/usr/local/bin/claude", error: "exited 7" } }) })).toBe(true);
});

it("folds away an agent nobody installed", () => {
  expect(detectedHere({ ok: false, need: "install", cli: cli({}) })).toBe(false);
});

it("treats an in-app engine as present unless its own files are missing", () => {
  expect(detectedHere({ ok: false, need: "model" })).toBe(true);
  expect(detectedHere({ ok: false, need: "service" })).toBe(true);
  expect(detectedHere({ ok: false, need: "install" })).toBe(false);
});
