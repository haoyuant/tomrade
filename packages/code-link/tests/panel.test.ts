import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Context } from "cordis";
import { inputsOf, promptOnScreen, SessionPanel, type CodeLinkStore, type SessionView } from "@tomradex/code-link";
import { arrowsTo, tailLines, trustOnScreen } from "@tomradex/code-link/prompt";
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

  it("reads the prompts other agents draw, as they were captured from their CLIs", () => {
    // Cursor numbers nothing: the cursor's arrow marks one row, and every row names its key
    const cursor = "$ sleep 1 in .\nRun this command?\nNot in allowlist: sleep\n→ Run (once) (y)\n  Add Shell(sleep) to allowlist? (tab)\n  Run Everything (shift+tab)\n  Skip & tell the agent what to do instead (esc or n)";
    expect(promptOnScreen(cursor)).toEqual({ selected: "Run (once) (y)", allows: true });
    expect(promptOnScreen(cursor.replace("→ Run (once)", "  Run (once)").replace("  Skip &", "→ Skip &"))).toEqual({ selected: "Skip & tell the agent what to do instead (esc or n)", allows: false });
    expect(promptOnScreen("Run this MCP tool?\n→ Run (once) (y)\n  Skip (esc or n)\n  Reject & propose changes (p)")).toEqual({ selected: "Run (once) (y)", allows: true });
    // OpenCode: a title, and the options on one row with the cursor's only by colour — No answers it, Yes cannot be told
    const opencode = "△ Permission required\n# Shell command\n$ sleep 1\nAllow once   Allow always   Reject          ctrl+f fullscreen  ⇆ select  enter confirm";
    expect(promptOnScreen(opencode)).toEqual({ selected: null, allows: false });
    expect(promptOnScreen(opencode.replace("   Reject", ""))).toBeNull();
    // Gemini CLI's file edit, and CodeBuddy's REPL in Code Mode
    expect(promptOnScreen("Apply this change?\n● 1. Allow once\n  2. Allow for this session\n  3. Modify with external editor\n  4. No, suggest changes (esc)")).toEqual({ selected: "Allow once", allows: true });
    expect(promptOnScreen('Confirm\nREPL\ncode: "sleep 1", description: "Wait a second"\nAre you sure you want to do this?\n> 1. Yes\n  2. Yes, and don\'t ask again this session (shift + tab)\n  3. No, and tell CodeBuddy what to do differently (escape)')).toEqual({ selected: "Yes", allows: true });
  });

  it("finds none where a key could do harm: a folder's trust, either way round, a shell, an agent's own input line", () => {
    expect(promptOnScreen(CLAUDE_TRUST)).toBeNull();
    expect(promptOnScreen("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit")).toBeNull();
    expect(promptOnScreen("Accessing workspace:\n/tmp/repo\nIs this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit")).toBeNull();
    expect(promptOnScreen("haoyuant@mac repo % echo marker-five\nmarker-five\nhaoyuant@mac repo %")).toBeNull();
    expect(promptOnScreen("What next?\n› Ask Codex to do anything\n  GPT-6.1 medium · 94% left")).toBeNull();
    expect(promptOnScreen("")).toBeNull();
    // a titled prompt about a folder's trust, and rows that name keys under no question at all
    expect(promptOnScreen("△ Permission required\nTrust this folder?\nAllow once   Allow always   Reject")).toBeNull();
    expect(promptOnScreen("Settings\n→ Theme (t)\n  Skip intro (esc)")).toBeNull();
  });
});

/** Folder trust as Claude Code 2.1 and Cursor Agent drew it in a fresh folder (2026-10-28), the cursor on "No, exit" in Claude's. */
const CLAUDE_TRUST_LIVE = [
  "────────────────────────────────────────────────────────────────────────",
  " Accessing workspace:",
  "",
  " /Users/me/Projects/demo-wt/fb-3",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
  " well-known open source project, or work from your team). If not, take a moment to review what's in",
  " this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel"
].join("\n");
const CURSOR_TRUST = [
  "  ╭────────────────────────────────────────────────────────────────╮",
  "  │  ⚠ Workspace Trust Required                                    │",
  "  │  Cursor Agent can execute code and access files in this directory. │",
  "  │  Do you trust the contents of this directory?                  │",
  "  │    /Users/me/Projects/demo-wt/fb-3                             │",
  "  │                                                                │",
  "  │  ▶ [a] Trust this workspace                                    │",
  "  │    [q] Quit                                                    │",
  "  │                                                                │",
  "  │  Use arrow keys to navigate, Enter to select, or press the key shown │",
  "  ╰────────────────────────────────────────────────────────────────╯"
].join("\n");
const screenFile = (name: string) => fs.readFileSync(path.join(__dirname, "../../pty-host/tests/fixtures/agent-screens", name), "utf8");

describe("a folder's trust on a pane's screen", () => {
  it("reads its options, the cursor's, and which trusts and which leaves, as each agent draws them", () => {
    expect(trustOnScreen(CLAUDE_TRUST_LIVE)).toEqual({ options: ["No, exit", "Yes, I trust this folder"], selected: 0, trust: 1, exit: 0 });
    expect(trustOnScreen(CLAUDE_TRUST)).toEqual({ options: ["No, exit", "Yes, I trust this folder"], selected: 0, trust: 1, exit: 0 });
    expect(trustOnScreen("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit")).toEqual({ options: ["Yes, proceed", "No, exit"], selected: 0, trust: 0, exit: 1 });
    expect(trustOnScreen(screenFile("codex-blocked-trust.txt"))).toEqual({ options: ["Yes, continue", "No, quit"], selected: 0, trust: 0, exit: 1 });
    expect(trustOnScreen(CURSOR_TRUST)).toEqual({ options: ["Trust this workspace", "Quit"], selected: 0, trust: 0, exit: 1 });
    // CodeBuddy offers three scopes: the narrowest, the folder alone, is the one taken
    expect(trustOnScreen(screenFile("codebuddy-blocked-trust.txt"))).toEqual({
      options: ["Trust folder only (fb-3)", "Trust parent folder (demo-wt/**)", "Trust folder and all subdirectories (fb-3/**)", "No, exit (escape)"],
      selected: 0,
      trust: 0,
      exit: 3
    });
    expect(trustOnScreen("Do you trust this folder?\n● 1. Trust folder (demo)\n  2. Trust parent folder (x)\n  3. Don't trust (esc)")).toMatchObject({ trust: 0, exit: 2 });
    // a wrapped option is the one before it, not an option of its own
    expect(trustOnScreen("Do you trust the files in this folder?\n> 1. Trust folder only\n     (a-very-long-name)\n  2. No, exit (escape)")).toMatchObject({ options: ["Trust folder only", "No, exit (escape)"], exit: 1 });
  });

  it("reads none it could not answer whole: no cursor, no way to leave or trust, or no such question", () => {
    expect(trustOnScreen(CLAUDE_TRUST.replace("❯ No, exit", "  No, exit"))).toBeNull();
    expect(trustOnScreen("Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. Maybe later")).toBeNull();
    expect(trustOnScreen(CLAUDE_ASKS)).toBeNull();
    expect(trustOnScreen("haoyuant@mac repo % echo trust me?\ntrust me?\nhaoyuant@mac repo %")).toBeNull();
    expect(trustOnScreen("")).toBeNull();
  });

  it("moves the cursor by arrows from where it is", () => {
    const claude = trustOnScreen(CLAUDE_TRUST_LIVE)!;
    expect(arrowsTo(claude, claude.trust)).toEqual(["down"]);
    expect(arrowsTo(claude, claude.exit)).toEqual([]);
    const codebuddy = trustOnScreen(screenFile("codebuddy-blocked-trust.txt"))!;
    expect(arrowsTo(codebuddy, codebuddy.exit)).toEqual(["down", "down", "down"]);
    expect(arrowsTo({ ...codebuddy, selected: 3 }, codebuddy.trust)).toEqual(["up", "up", "up"]);
  });
});

const session = (over: Partial<SessionView>): SessionView => ({
  id: "s1", projectId: "p", repoId: "r", delivery: 1, branch: "", itemIds: [], worked: [], mode: "terminal", agent: "claude-code",
  externalId: "abc", threadId: null, worktree: null, herdrPane: "w1:p1", terminal: null, title: null, cwd: null, transcript: null,
  prompted: true, withoutTicket: null, recordSavedAt: null, recordCut: false, state: "waiting", lastEventAt: 5, lastToolAt: null, lastCommitAt: null,
  summary: null, activity: null, ask: { kind: "permission", tool: "Bash", action: "run", detail: "pnpm test" }, blocked: null, requestedBy: null, autoMerge: false, device: "here", startedAt: 1, endedAt: null, ...over
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
    // Esc goes as at the pane's keyboard, whatever the screen shows: it closes the agent's own menus and panels
    expect(await panel.escape("p", "s3")).toBe(true);
    expect(fake.of("pane.send_input").at(-1)).toEqual({ pane_id: "w1:p1", keys: ["esc"] });
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
    expect(await panel.escape("p", "s1")).toBe(false);
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

  it("glances at a live session's pane for its card: its last lines, and the prompt only where its agent declared keys", async () => {
    const fake = new FakeHerdr();
    const pane = fake.createPane("/work");
    pane.text = CLAUDE_ASKS;
    const asks = session({});
    const runs = session({ id: "runs", state: "running", activity: "Bash · pnpm test" });
    const mute = session({ id: "mute", agent: "mute" });
    const away = session({ id: "away", herdrPane: null, terminal: "iTerm.app" });
    const panel = await panelOn(fake, {});
    const reads = () => fake.of("pane.read").length;
    const lines = tailLines(CLAUDE_ASKS, 2);
    const seen = await panel.glance([asks, runs, mute, away], 1000);
    expect(Object.fromEntries(seen)).toEqual({ s1: { approval: true, prompt: "allow", tail: lines }, runs: { approval: true, prompt: null, tail: lines }, mute: { approval: false, prompt: null, tail: lines }, away: { approval: true, prompt: null, tail: null } });
    // the prompt reads as many rows as it may need, the lines alone a strip's worth; a session with no pane here none
    expect(fake.of("pane.read").map((r) => r.lines).sort()).toEqual([12, 12, 30]);
    // the same event again reads nothing, until the lines are old; a new event reads again, but not twice within two seconds
    await panel.glance([asks, runs], 1500);
    expect(reads()).toBe(3);
    await panel.glance([{ ...runs, lastEventAt: 6 }], 2500);
    expect(reads()).toBe(3);
    await panel.glance([{ ...runs, lastEventAt: 6 }], 3100);
    expect(reads()).toBe(4);
    await panel.glance([{ ...runs, lastEventAt: 7 }], 4000);
    expect(reads()).toBe(4);
    await panel.glance([{ ...runs, lastEventAt: 7 }], 5200);
    expect(reads()).toBe(5);
    await panel.glance([{ ...runs, lastEventAt: 7 }], 14_000);
    expect(reads()).toBe(5);
    await panel.glance([{ ...runs, lastEventAt: 7 }], 15_300);
    expect(reads()).toBe(6);
    // the cursor on No, after its next event, leaves Deny only — read at once, as Allow and Deny need
    pane.text = CLAUDE_ASKS.replace("❯ 1. Yes", "  1. Yes").replace("  3. No", "❯ 3. No");
    expect((await panel.glance([{ ...asks, lastEventAt: 6 }], 1600)).get("s1")?.prompt).toBe("deny");
    // a screen with no prompt is looked at again only after a while
    pane.text = "haoyuant@mac repo %";
    expect((await panel.glance([{ ...asks, lastEventAt: 7 }], 2000)).get("s1")?.prompt).toBeNull();
    const before = reads();
    await panel.glance([{ ...asks, lastEventAt: 7 }], 3000);
    expect(reads()).toBe(before);
    await panel.glance([{ ...asks, lastEventAt: 7 }], 4500);
    expect(reads()).toBe(before + 1);
    // no longer asking, its prompt is gone at once
    expect((await panel.glance([{ ...asks, state: "running", activity: null, lastEventAt: 7 }], 4600)).get("s1")?.prompt).toBeNull();
    fake.close();
  });

  it("answers a folder's trust by moving the cursor to the option first and pressing Enter only once it is there", async () => {
    const fake = new FakeHerdr();
    const pane = fake.createPane("/work");
    // the agent's screen follows the arrows it is sent, as Claude Code's does, after `lag` ms (never, at Infinity)
    let lag = 0;
    const down = () => (pane.text = pane.text.replace("❯ No, exit", "  No, exit").replace("  Yes, I trust", "❯ Yes, I trust"));
    fake.answer = (method, params) => {
      const keys = (params.keys as string[] | undefined) ?? [];
      if (method === "pane.send_input" && keys[0] === "down" && lag === 0) down();
      else if (method === "pane.send_input" && keys[0] === "down" && Number.isFinite(lag)) setTimeout(down, lag);
      return undefined;
    };
    const blocked = { state: "waiting" as const, ask: { kind: "permission" as const, tool: null, action: null, detail: null } };
    const panel = await panelOn(fake, { s1: session(blocked), mute: session({ ...blocked, id: "mute", agent: "mute" }) });
    pane.text = CLAUDE_TRUST_LIVE;
    expect(await panel.trust("p", "s1", "trust")).toBe("answered");
    expect(fake.of("pane.send_input")).toEqual([{ pane_id: "w1:p1", keys: ["down"] }, { pane_id: "w1:p1", keys: ["enter"] }]);
    // already there: Enter alone, for any agent, keys declared or not
    pane.text = CLAUDE_TRUST_LIVE;
    expect(await panel.trust("p", "mute", "exit")).toBe("answered");
    expect(fake.of("pane.send_input").slice(2)).toEqual([{ pane_id: "w1:p1", keys: ["enter"] }]);
    // the screen redraws a moment late: Enter waits for it
    pane.text = CLAUDE_TRUST_LIVE;
    lag = 250;
    expect(await panel.trust("p", "s1", "trust")).toBe("answered");
    // a cursor that never gets there gets no Enter
    pane.text = CLAUDE_TRUST_LIVE;
    lag = Infinity;
    const sent = fake.of("pane.send_input").length;
    expect(await panel.trust("p", "s1", "trust")).toBe("failed");
    expect(fake.of("pane.send_input").slice(sent)).toEqual([{ pane_id: "w1:p1", keys: ["down"] }]);
    // no trust on the screen, nothing pressed
    pane.text = CLAUDE_ASKS;
    expect(await panel.trust("p", "s1", "trust")).toBe("notPrompt");
    expect(fake.of("pane.send_input").length).toBe(sent + 1);
    fake.close();
  });

  it("glances a folder's trust for the card of a session only its screen said waits, its agent's keys or none", async () => {
    const fake = new FakeHerdr();
    const pane = fake.createPane("/work");
    pane.text = CLAUDE_TRUST_LIVE;
    const blocked = { state: "waiting" as const, ask: { kind: "permission" as const, tool: null, action: null, detail: null } };
    const panel = await panelOn(fake, {});
    const seen = await panel.glance([session(blocked), session({ ...blocked, id: "mute", agent: "mute" }), session({ id: "bash", agent: "mute" })], 1000);
    expect([...seen.values()].map((g) => g.prompt)).toEqual(["trust", "trust", null]);
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
