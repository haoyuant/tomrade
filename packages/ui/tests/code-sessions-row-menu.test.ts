import { expect, it, vi } from "vitest";
import type { SessionRow, TerminalRow, ThreadRow } from "@tomradex/code-sessions";
import type { HereRow } from "../src/code-sessions/lists";

vi.mock("~/components/ui/menu", () => ({ ContextMenu: () => null, ContextMenuActionItem: () => null, ContextMenuSeparator: () => null }));
vi.mock("../src/code-sessions/bridge", () => ({ send: () => undefined }));
vi.mock("../src/code-sessions/changes", () => ({ showChanges: () => undefined }));
vi.mock("../src/code-sessions/say", () => ({ useSay: () => (key: string) => key }));
const { rowActions } = await import("../src/code-sessions/rowMenu");

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: "s", itemId: null, key: null, title: null, branch: "tom-1/work", state: "running", needsYou: false, activity: null, failedTool: null, ask: null,
  mode: "terminal", agent: "claude-code", agentName: "Claude Code", agentTitle: null, conversation: null, cwd: "/repo", prompted: true, resumable: false,
  pane: "w1:p1", where: "herdr", terminal: null, switchable: false, threadId: null, prUrl: null, worktree: null, startedAt: 1, endedAt: null,
  continuedIn: null, ranIn: null, recordSaved: null, approval: false, prompt: null, lastEventAt: null, rawOutput: false, outcome: null, tail: null, guess: null, ...over
});
const terminal = (over: Partial<TerminalRow> = {}): TerminalRow => ({ id: "t", title: "zsh", cwd: "/repo", pane: "w1:p2", startedAt: 1, agentTitle: null, agentStatus: null, running: null, shell: true, sessionId: null, note: null, ...over });
const thread = (over: Partial<ThreadRow> = {}): ThreadRow => ({ id: "th", title: "Ask", engine: "loop", engineName: null, itemId: null, key: null, ticketTitle: null, parentId: null, running: false, ticketDone: false, wait: null, createdAt: 1, updatedAt: 1, ...over });

it("offers a ticket session in a pane here its ticket, worktree, PR and what names it", () => {
  const r: HereRow = { kind: "session", id: "s", session: session({ itemId: "i1", key: "TOM-1", threadId: "th" }) };
  expect(rowActions(r)).toEqual([
    ["open", "openBeside"],
    ["openTicket", "changes", "openThread", "openWorktree", "openPr"],
    ["copyKey", "copyBranch", "copyFolder"]
  ]);
});

it("offers a plain terminal its folder and closing it, and no ticket things", () => {
  expect(rowActions({ kind: "terminal", id: "t", terminal: terminal(), session: null })).toEqual([["open", "openBeside"], ["copyFolder"], ["closeTerminal"]]);
});

it("switches to the terminal app an outside session runs in, while it lives", () => {
  const live: HereRow = { kind: "session", id: "s", session: session({ where: "outside", pane: null, switchable: true, terminal: "iTerm2" }) };
  expect(rowActions(live)[0]).toEqual(["open", "switchTo"]);
  const ended: HereRow = { kind: "session", id: "s", session: session({ where: "outside", pane: null, switchable: true, endedAt: 5 }) };
  expect(rowActions(ended)[0]).toEqual(["open"]);
});

it("opens a conversation in the app window, with its ticket when it has one", () => {
  expect(rowActions({ kind: "thread", id: "th", thread: thread({ itemId: "i2", key: "TOM-2" }), session: null })).toEqual([["open"], ["openTicket", "changes"], ["copyKey"]]);
});
