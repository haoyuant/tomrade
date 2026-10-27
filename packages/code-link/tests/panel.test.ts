import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { inputsOf, promptOnScreen, SessionPanel, type CodeLinkStore, type SessionView } from "@tomradex/code-link";
import { Herdr } from "@tomradex/herdr";
import { FakeHerdr } from "@tomradex/testkit";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-code-panel-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("keys as an agent declares them", () => {
  it("types characters as text and presses named keys after them, in order", () => {
    expect(inputsOf(["enter"])).toEqual([{ keys: ["enter"] }]);
    expect(inputsOf(["y"])).toEqual([{ text: "y" }]);
    expect(inputsOf(["1", "enter"])).toEqual([{ text: "1", keys: ["enter"] }]);
    expect(inputsOf(["esc", "esc"])).toEqual([{ keys: ["esc", "esc"] }]);
    // a character after a key cannot ride in the same send, or it would be typed first
    expect(inputsOf(["esc", "n", "enter"])).toEqual([{ keys: ["esc"] }, { text: "n", keys: ["enter"] }]);
    expect(inputsOf(["拒", "enter"])).toEqual([{ text: "拒", keys: ["enter"] }]);
    expect(inputsOf([])).toEqual([]);
  });
});

const CLAUDE_ASKS = ["╭──────────────────────────────╮", "│ Bash command                 │", "│   pnpm test                  │", "│ Do you want to proceed?      │", "│ ❯ 1. Yes                     │", "│   2. Yes, and don't ask again │", "│   3. No, and tell Claude what to do differently (esc) │", "╰──────────────────────────────╯"].join("\n");
const CODEX_ASKS = "Would you like to run the following command?\n\n  $ rm -rf dist\n\n› 1. Yes, proceed (y)\n  2. Yes, and don't ask again for this command (a)\n  3. No, and tell Codex what to do differently (esc)\n\n  Press enter to confirm or esc to cancel";
const CLAUDE_TRUST = "Do you trust the files in this folder?\n\n/private/tmp/repo\n\n❯ No, exit\n  Yes, I trust this folder\n\nEnter to confirm · Esc to cancel";

describe("the prompt on a pane's screen", () => {
  it("reads a tool's permission prompt and whether yes is under the cursor", () => {
    expect(promptOnScreen(CLAUDE_ASKS)).toEqual({ selected: "Yes", allows: true });
    expect(promptOnScreen(CODEX_ASKS)).toEqual({ selected: "Yes, proceed (y)", allows: true });
    expect(promptOnScreen("Allow execution of: 'rm'?\n● 1. Allow once\n  2. Allow always\n  3. No, suggest changes (esc)")).toEqual({ selected: "Allow once", allows: true });
    // the cursor moved to No: Deny may still press, Allow must not
    expect(promptOnScreen(CLAUDE_ASKS.replace("❯ 1. Yes", "  1. Yes").replace("  3. No", "❯ 3. No"))).toEqual({ selected: "No, and tell Claude what to do differently (esc)", allows: false });
    // a narrow pane wraps the question
    expect(promptOnScreen("Do you want to make this edit to\npackages/ui/src/App.tsx?\n❯ 1. Yes\n  2. No")).toEqual({ selected: "Yes", allows: true });
  });

  it("finds none where a key could do harm: a folder's trust, either way round, a shell, an agent's own input line", () => {
    expect(promptOnScreen(CLAUDE_TRUST)).toBeNull();
    expect(promptOnScreen("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit")).toBeNull();
    expect(promptOnScreen("Accessing workspace:\n/tmp/repo\nIs this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit")).toBeNull();
    expect(promptOnScreen("haoyuant@mac repo % echo marker-five\nmarker-five\nhaoyuant@mac repo %")).toBeNull();
    expect(promptOnScreen("What next?\n› Ask Codex to do anything\n  GPT-6.1 medium · 94% left")).toBeNull();
    expect(promptOnScreen("")).toBeNull();
  });
});

const session = (over: Partial<SessionView>): SessionView => ({
  id: "s1", projectId: "p", repoId: "r", delivery: 1, branch: "", itemIds: [], worked: [], mode: "terminal", agent: "claude-code",
  externalId: "abc", threadId: null, worktree: null, herdrPane: "w1:p1", terminal: null, title: null, cwd: null, transcript: null,
  prompted: true, withoutTicket: null, recordSavedAt: null, recordCut: false, state: "waiting", lastEventAt: 5, lastToolAt: null, lastCommitAt: null,
  summary: null, activity: "needs your approval: Bash", blocked: null, requestedBy: null, autoMerge: false, device: "here", startedAt: 1, endedAt: null, ...over
});

/** A panel over herdr (a fake on its socket) and two agents: one that declares its approval keys, one that does not. */
async function panelOn(fake: FakeHerdr, sessions: Record<string, SessionView>, opts: { terminals?: boolean } = {}) {
  const ctx = new Context();
  if (opts.terminals !== false) await ctx.plugin(Herdr, { reconnectMs: 30, socket: fake.socket, bin: path.join(root, "absent") });
  const engines: Record<string, { local?: { approval?: { allow: string[]; deny: string[] } } }> = {
    "claude-code": { local: { approval: { allow: ["enter"], deny: ["esc"] } } },
    codex: { local: { approval: { allow: ["y"], deny: ["n"] } } },
    mute: { local: {} }
  };
  ctx.provide("agent", { engineOf: (id: string) => engines[id] } as never);
  const store = { session: (_projectId: string, id: string) => sessions[id] ?? null } as unknown as CodeLinkStore;
  return new SessionPanel(ctx, store);
}

describe("the panel's side of a terminal session", () => {
  it("types into the pane with Enter and presses the agent's own keys for Allow and Deny, through the pane surface only", async () => {
    const fake = new FakeHerdr();
    const pane = fake.createPane("/work");
    const panel = await panelOn(fake, { s1: session({}), s2: session({ id: "s2", agent: "codex" }), s3: session({ id: "s3", agent: "mute" }) });
    expect(panel.view("p", "s1")).toEqual({ pane: pane.pane_id, input: "ok", approval: true });
    expect(panel.view("p", "s3")).toEqual({ pane: pane.pane_id, input: "ok", approval: false });

    expect(await panel.say("p", "s1", "look at the tests")).toBe(true);
    pane.text = CLAUDE_ASKS;
    expect(await panel.answer("p", "s1", "allow")).toBe("answered");
    expect(await panel.answer("p", "s1", "deny")).toBe("answered");
    pane.text = CODEX_ASKS;
    expect(await panel.answer("p", "s2", "allow")).toBe("answered");
    expect(fake.of("pane.send_input")).toEqual([
      { pane_id: "w1:p1", text: "look at the tests", keys: ["enter"] },
      { pane_id: "w1:p1", keys: ["enter"] },
      { pane_id: "w1:p1", keys: ["esc"] },
      { pane_id: "w1:p1", text: "y" }
    ]);
    // a screen that asks no permission gets no key, Allow or Deny: Enter on a folder's trust may be "No, exit"
    pane.text = CLAUDE_TRUST;
    expect(await panel.answer("p", "s1", "allow")).toBe("notPrompt");
    expect(await panel.answer("p", "s1", "deny")).toBe("notPrompt");
    pane.text = "haoyuant@mac repo %";
    expect(await panel.answer("p", "s1", "allow")).toBe("notPrompt");
    expect(fake.of("pane.send_input")).toHaveLength(4);
    pane.text = CLAUDE_ASKS;
    // never an agent call (it fails until herdr detects the agent) and never a control session (it would take the pane)
    expect(fake.of("agent.prompt")).toEqual([]);
    expect(fake.of("agent.send_keys")).toEqual([]);
    expect(fake.calls.map((c) => c.method).filter((m) => m.startsWith("pane.attach") || m.startsWith("terminal"))).toEqual([]);

    // an agent without keys answers nothing; nothing goes to a pane that is gone
    expect(await panel.answer("p", "s3", "allow")).toBe("failed");
    expect(await panel.say("p", "s1", "")).toBe(false);
    fake.exit(pane.pane_id);
    expect(await panel.say("p", "s1", "still there?")).toBe(false);
    expect(await panel.answer("p", "s1", "allow")).not.toBe("answered");
    fake.close();
  });

  it("reads the pane's last lines, as many as asked within reason, and none without a pane", async () => {
    const fake = new FakeHerdr();
    const pane = fake.createPane("/work");
    pane.text = "one\ntwo\nthree";
    const panel = await panelOn(fake, { s1: session({}), out: session({ id: "out", herdrPane: null, terminal: "iTerm.app" }) });
    expect(await panel.tail("p", "s1", 2)).toBe("one\ntwo\nthree");
    expect(fake.of("pane.read").at(-1)).toMatchObject({ pane_id: "w1:p1", source: "recent", lines: 2 });
    await panel.tail("p", "s1", 9999);
    expect(fake.of("pane.read").at(-1)).toMatchObject({ lines: 200 });
    await panel.tail("p", "s1", 0);
    expect(fake.of("pane.read").at(-1)).toMatchObject({ lines: 1 });
    expect(await panel.tail("p", "out", 2)).toBeNull();
    expect(await panel.tail("p", "nobody", 2)).toBeNull();
    fake.close();
  });

  it("says why typing cannot reach a session: no pane, ended, or no terminal backend on this machine", async () => {
    const fake = new FakeHerdr();
    fake.createPane("/work");
    const sessions = { out: session({ id: "out", herdrPane: null, terminal: "iTerm.app" }), over: session({ id: "over", state: "ended", endedAt: 9 }) };
    const panel = await panelOn(fake, sessions);
    expect(panel.view("p", "out")).toEqual({ pane: null, input: "noPane", approval: true });
    expect(panel.view("p", "over")).toEqual({ pane: "w1:p1", input: "ended", approval: true });
    expect(await panel.say("p", "out", "hello")).toBe(false);
    expect(await panel.say("p", "over", "hello")).toBe(false);
    expect(panel.view("p", "nobody")).toEqual({ pane: null, input: "ended", approval: false });
    const bare = await panelOn(fake, { s1: session({}) }, { terminals: false });
    expect(bare.view("p", "s1")).toEqual({ pane: "w1:p1", input: "noBackend", approval: true });
    expect(await bare.say("p", "s1", "hello")).toBe(false);
    expect(await bare.tail("p", "s1", 2)).toBeNull();
    fake.close();
  });
});
