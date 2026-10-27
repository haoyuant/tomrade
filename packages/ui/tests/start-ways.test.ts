import { expect, it } from "vitest";
import { startWays, wayKey, wayOf } from "../src/lib/startWays";

const engine = (id: string, extra: { ok?: boolean; terminal?: boolean; terminalOnly?: boolean; capabilities?: ("code" | "general" | "backlog")[] } = {}) => ({
  id,
  ok: extra.ok ?? true,
  capabilities: extra.capabilities ?? ["code"],
  ...(extra.terminal === false ? { terminal: false } : {}),
  ...(extra.terminalOnly ? { terminalOnly: true } : {})
});
const engines = [engine("claude-code"), engine("codex"), engine("tomrade", { terminal: false, capabilities: ["backlog", "code", "general"] }), engine("broken", { ok: false })];

it("offers the one-click agent in a background pane and with the Terminal window, another agent in a pane, and the built-in assistant", () => {
  const ways = startWays({ engines, capability: "code", primary: "claude-code", panes: true });
  expect(ways.map(wayKey)).toEqual(["pane:claude-code", "window:claude-code", "pane:codex", "builtin:tomrade"]);
  expect(ways[1]).toMatchObject({ mode: "terminal", window: true });
  expect(ways[3]).toMatchObject({ mode: "run", window: false });
});

it("leads with the way one click goes, so the menu always has it", () => {
  const quick = wayOf({ mode: "terminal", engine: "codex", panes: true, window: false });
  expect(startWays({ engines, capability: "code", primary: "codex", panes: true, quick }).map(wayKey)).toEqual(["pane:codex", "window:codex", "pane:claude-code", "builtin:tomrade"]);
  // last time it ran here, headless: that way comes first, the panes after it
  const here = wayOf({ mode: "run", engine: "claude-code", panes: true, window: false });
  expect(startWays({ engines, capability: "code", primary: "claude-code", panes: true, quick: here }).map(wayKey)).toEqual(["here:claude-code", "pane:claude-code", "window:claude-code", "pane:codex", "builtin:tomrade"]);
  // Settings › Sessions said to bring up the Terminal window: that one leads
  const window = wayOf({ mode: "terminal", engine: "claude-code", panes: true, window: true });
  expect(startWays({ engines, capability: "code", primary: "claude-code", panes: true, quick: window }).map(wayKey)[0]).toBe("window:claude-code");
});

it("without panes, terminal agents open in a terminal app and the first can also run here", () => {
  expect(startWays({ engines, capability: "code", primary: "claude-code", panes: false }).map(wayKey)).toEqual(["terminal:claude-code", "here:claude-code", "terminal:codex", "builtin:tomrade"]);
  expect(wayOf({ mode: "terminal", engine: "codex", panes: false, window: true })).toEqual({ kind: "terminal", mode: "terminal", engine: "codex", window: false });
});

it("leaves out agents that are not ready or cannot do the work, and the built-in assistant when it cannot code", () => {
  const ways = startWays({ engines: [engine("claude-code"), engine("tomrade", { terminal: false, capabilities: ["backlog"] }), engine("writer", { capabilities: ["general"] })], capability: "code", primary: "broken", panes: true });
  expect(ways.map(wayKey)).toEqual(["pane:claude-code", "window:claude-code"]);
  expect(startWays({ engines: undefined, capability: "code", primary: null, panes: true })).toEqual([]);
});
