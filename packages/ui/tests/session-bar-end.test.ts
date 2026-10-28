import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { ThreadSummary } from "@tomradex/agent";
import type { SessionView } from "@tomradex/code-link";
import { SessionBar, type BarMode } from "../src/components/workspace/agent-panel/SessionBar";
import { sessionBarRows, type BarRow } from "../src/lib/sessionBar";

vi.mock("~/components/icons", () => ({ Icon: () => null }));
vi.mock("~/components/ui/menu", () => ({ ContextMenu: ({ trigger }: { trigger: unknown }) => trigger, ContextMenuActionItem: () => null }));
vi.mock("~/lib/attention", () => ({ ATTENTION_KEY: {} }));
vi.mock("~/lib/agent", () => ({ findEngine: () => undefined }));
vi.mock("~/lib/domain", () => ({ clockLabel: () => "", timeAgo: () => "" }));
vi.mock("~/lib/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock("~/lib/keybindings", () => ({ keyLabel: () => "" }));
vi.mock("~/lib/review", () => ({ outcomeLine: () => "" }));
vi.mock("~/lib/sessionTime", () => import("../src/lib/sessionTime"));
vi.mock("~/lib/terminalSession", () => import("../src/lib/terminalSession"));

const thread = (id: string): ThreadSummary => ({
  id, projectId: "p", boardId: null, itemId: null, branch: null, title: `thread ${id}`, engine: "loop", surface: "assistant", archived: false, createdAt: 1, updatedAt: 1
});
const session = (id: string, over: Partial<SessionView> = {}): SessionView => ({
  id, projectId: "p", repoId: "r", delivery: 1, branch: "", itemIds: [], worked: [], mode: "terminal", agent: "claude-code",
  externalId: null, threadId: null, worktree: null, herdrPane: "w1:p1", terminal: null, title: `session ${id}`, cwd: null, transcript: null,
  prompted: true, withoutTicket: null, recordSavedAt: null, recordCut: false, state: "running", lastEventAt: 5, lastToolAt: null, lastCommitAt: null,
  summary: null, activity: null, blocked: null, requestedBy: null, autoMerge: false, device: "here", startedAt: 1, endedAt: null, ...over
});
const noop = () => {};
const bar = (rows: BarRow[], mode: BarMode) =>
  renderToStaticMarkup(createElement(SessionBar, {
    rows, starting: [], openKey: null, mode, engines: [], pendings: new Map(),
    onMode: noop, onPick: noop, onAnswer: noop, onNew: noop, onHistory: noop, onArchive: noop, onDelete: noop, onEnd: noop
  }));
/** The rows' cards, each cut out of the markup by its key. */
const cards = (html: string) => Object.fromEntries(html.split('class="sbar-card"').slice(1).map((card) => [/data-key="([^"]+)"/.exec(card)![1], card]));

it("lets a terminal session the bar shows be ended from its card, while it waits, runs or idles, and never once it ended", () => {
  const rows = sessionBarRows({
    threads: [thread("t")],
    sessions: [
      session("waits", { state: "waiting", summary: "TOM-772 is merged." }),
      session("runs"),
      session("idles", { state: "idle", herdrPane: null, terminal: "iTerm.app" }),
      session("ended", { state: "ended", endedAt: 8 })
    ],
    attention: [], itemTitle: () => null, openThreadId: null
  });
  const shown = cards(bar(rows, "cards"));
  expect(shown["session:waits"]).toContain('data-testid="sbar-end"');
  expect(shown["session:runs"]).toContain('data-testid="sbar-end"');
  // one in another terminal app only leaves the bar, which the confirmation says; the button is the same
  expect(shown["session:idles"]).toContain('data-testid="sbar-end"');
  expect(shown["session:ended"]).not.toContain('data-testid="sbar-end"');
  // an assistant conversation is archived or deleted, not ended
  expect(shown["thread:t"]).not.toContain('data-testid="sbar-end"');
});
