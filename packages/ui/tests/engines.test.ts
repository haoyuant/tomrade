import { expect, it } from "vitest";
import type { EnginePick, EngineTry, EngineView, LocalCliStatus } from "@tomradex/agent";
import { detectedHere, failedTry, pickChoiceName, pickTitleOf } from "../src/lib/engines";
import { agentPanel } from "../src/lib/i18n-messages/agentPanel";
import { localCli } from "../src/lib/i18n-messages/localCli";
import { engineStateLabel } from "../src/lib/localCli";

const cli = (over: Partial<LocalCliStatus>): LocalCliStatus => ({ name: "x", state: "missing", attempts: [], searched: [], platform: "darwin", arch: "arm64", pathEnv: "", ...over });

/** The English words, with the namespace the app's `t` expects. */
const t = (key: string, vars: Record<string, string | number> = {}): string => {
  const text = (localCli.en as Record<string, string>)[key.replace(/^localCli\./, "")] ?? key;
  return text.replace(/{{(\w+)}}/g, (_match, name: string) => String(vars[name] ?? ""));
};

const words = (key: string): string => (agentPanel.en as Record<string, string>)[key.replace(/^agentPanel\./, "")] ?? key;

it("words the CodeBuddy edition pick for the interface, not the plugin", () => {
  const pick: EnginePick = { key: "region", title: "Version", choices: [] };
  expect(pickTitleOf(words, pick)).toBe("Version");
  expect(pickChoiceName(words, pick, { value: "china", label: "China edition" })).toBe("China edition");
  expect(pickChoiceName(words, pick, { value: "international", label: "International" })).toBe("International");
  // Another plugin's pick keeps its own words.
  expect(pickChoiceName(words, { key: "profile", title: "Profile", choices: [] }, { value: "work", label: "Work" })).toBe("Work");
});

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

it("says a failed test message instead of Ready, and shows the agent's own words", () => {
  const view = (tried?: EngineTry): EngineView => ({ id: "x", title: "X", capabilities: [], ok: true, tried });
  const failed = view({ ok: false, ms: 10, at: 1, error: "400 internal error" });
  expect(engineStateLabel(failed, t, "unavailable")).toBe("Test failed — 400 internal error");
  expect(engineStateLabel(view({ ok: true, ms: 10, at: 1, reply: "OK" }), t, "unavailable")).toBe("Ready");
  expect(failedTry(failed)).toMatchObject({ error: "400 internal error" });
  expect(failedTry(view({ ok: true, ms: 10, at: 1, reply: "OK" }))).toBeUndefined();
  // An older try without words still says why it is not ready.
  expect(engineStateLabel(view({ ok: false, ms: 10, at: 1 }), t, "unavailable")).toBe("Test failed — no reply");
});
