import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateFiles, invalidateSessions, invalidateWorkspace, invalidateWrites, SESSIONS_GAP_MS, SESSIONS_SETTLE_MS, sessionsRefresher } from "../src/lib/queries/invalidate";
import { putItem } from "../src/lib/queries/items";
import { keys } from "../src/lib/queries/keys";

describe("a ticket write", () => {
  it("asks again for its own project's contributions, and leaves the ones that do not read tickets", () => {
    const qc = new QueryClient();
    const cached = {
      badges: keys.badges("p"),
      sidebar: keys.sidebarModules("p"),
      section: keys.sections("p", "item"),
      edges: keys.graphEdges("p", "deps"),
      status: keys.statusItems("p"),
      statusAnywhere: keys.statusItems(),
      otherBadges: keys.badges("q"),
      commands: keys.commands,
      graphs: keys.graphs,
      accessories: keys.assistantAccessories
    };
    for (const key of Object.values(cached)) qc.setQueryData(key, []);
    invalidateWorkspace(qc, "p");
    const stale = Object.entries(cached).filter(([, key]) => qc.getQueryState(key)?.isInvalidated).map(([name]) => name);
    expect(stale).toEqual(["badges", "sidebar", "section", "edges", "status", "statusAnywhere"]);
  });
});

describe("writes heard from the main process", () => {
  const cachedProject = () => ({
    window: keys.itemsWindow("p", 50, 30),
    labels: keys.labels("p"),
    badges: keys.badges("p"),
    views: keys.views("p"),
    ranks: keys.ranks("view"),
    boards: keys.boards("p"),
    fields: keys.fields("p"),
    projects: keys.projects,
    storage: keys.storageStatus("p")
  });
  const staleAfter = (entities: string[]) => {
    const qc = new QueryClient();
    const cached = cachedProject();
    for (const key of Object.values(cached)) qc.setQueryData(key, []);
    invalidateWrites(qc, "p", entities);
    return Object.entries(cached).filter(([, key]) => qc.getQueryState(key)?.isInvalidated).map(([name]) => name);
  };

  it("a dragged card's rank asks again for views and ranks only", () => {
    expect(staleAfter(["view"])).toEqual(["views", "ranks"]);
  });

  it("a ticket asks again for what reads tickets, not boards, fields or the projects list", () => {
    expect(staleAfter(["item"])).toEqual(["window", "labels", "badges"]);
  });

  it("a card dropped in another column, a ticket and its rank, asks for both", () => {
    expect(staleAfter(["item", "view"])).toEqual(["window", "labels", "badges", "views", "ranks"]);
  });

  it("a board, an undo of all three, or anything unknown asks for everything, as before", () => {
    const all = ["window", "labels", "badges", "views", "ranks", "boards", "fields", "projects", "storage"];
    expect(staleAfter(["board"])).toEqual(all);
    expect(staleAfter(["item", "board", "view"])).toEqual(all);
    expect(staleAfter(["something-new"])).toEqual(all);
  });
});

describe("a ticket written from this window", () => {
  it("is put in every list that holds it, and nothing is asked again until its broadcast", () => {
    const qc = new QueryClient();
    const before = { id: "a", title: "Old", version: 1 };
    const other = { id: "b", title: "Other", version: 1 };
    qc.setQueryData(keys.itemsWindow("p", 50, 30), [before, other]);
    qc.setQueryData(keys.item("p", "a"), before);
    qc.setQueryData(keys.itemQuery("p", "count", {}), 2);
    qc.setQueryData(keys.itemsWindow("q", 50, 30), [before]);
    const after = { ...before, title: "New", version: 2 };
    putItem(qc, "p", after as never);
    expect(qc.getQueryData(keys.itemsWindow("p", 50, 30))).toEqual([after, other]);
    expect(qc.getQueryData(keys.item("p", "a"))).toEqual(after);
    expect(qc.getQueryData(keys.itemQuery("p", "count", {}))).toBe(2);
    expect(qc.getQueryData(keys.itemsWindow("q", 50, 30))).toEqual([before]);
    expect(qc.getQueryState(keys.itemsWindow("p", 50, 30))?.isInvalidated).toBe(false);
  });
});

describe("a change to a project's files", () => {
  const cachedFiles = () => ({
    tree: keys.files.tree("p"),
    status: keys.files.status("p"),
    edited: keys.files.content("p", "notes/a.md"),
    editedHistory: keys.files.history("p", "notes/a.md"),
    inMovedFolder: keys.files.content("p", "notes/sub/b.md"),
    untouched: keys.files.content("p", "other.md"),
    untouchedHistory: keys.files.history("p", "other.md"),
    version: keys.files.version("p", "f1", "v1"),
    attachments: keys.files.attachmentsOf("p", "item"),
    timeline: keys.timeline("p"),
    otherProject: keys.files.tree("q")
  });
  const staleAfter = (paths?: string[]) => {
    const qc = new QueryClient();
    const cached = cachedFiles();
    for (const key of Object.values(cached)) qc.setQueryData(key, []);
    invalidateFiles(qc, "p", paths);
    return Object.entries(cached).filter(([, key]) => qc.getQueryState(key)?.isInvalidated).map(([name]) => name);
  };

  it("naming its paths asks again for the tree, status and those files, keeping every other open file", () => {
    expect(staleAfter(["notes/a.md"])).toEqual(["tree", "status", "edited", "editedHistory", "attachments", "timeline"]);
    // A folder moved or removed takes what is under it along.
    expect(staleAfter(["notes"])).toEqual(["tree", "status", "edited", "editedHistory", "inMovedFolder", "attachments", "timeline"]);
  });

  it("naming none (a sync, an outside edit) asks again for everything, as before", () => {
    expect(staleAfter()).toEqual(["tree", "status", "edited", "editedHistory", "inMovedFolder", "untouched", "untouchedHistory", "version", "attachments", "timeline"]);
  });
});

describe("a session's hook", () => {
  it("asks again for what reads sessions and the open ticket's sections; the board's badges only once one moved; never tickets or threads", () => {
    const qc = new QueryClient();
    const cached = {
      recent: keys.codeLink.recentSessions("p"),
      ticketSessions: keys.codeLink.sessions("p", "item"),
      timeline: keys.codeLink.timeline("p", "item"),
      handoff: keys.codeLink.handoff("p", "thread"),
      review: keys.codeLink.review("p", ""),
      section: keys.sections("p", "item"),
      badges: keys.badges("p"),
      items: keys.items("p"),
      threads: keys.agent.threads("p"),
      links: keys.codeLink.links("p", "item"),
      otherRecent: keys.codeLink.recentSessions("q")
    };
    const stale = (moved: boolean) => {
      for (const key of Object.values(cached)) qc.setQueryData(key, []);
      invalidateSessions(qc, "p", moved);
      return Object.entries(cached).filter(([, key]) => qc.getQueryState(key)?.isInvalidated).map(([name]) => name);
    };
    expect(stale(false)).toEqual(["recent", "ticketSessions", "timeline", "handoff", "review", "section"]);
    expect(stale(true)).toEqual(["recent", "ticketSessions", "timeline", "handoff", "review", "section", "badges"]);
  });
});

describe("a burst of session hooks", () => {
  afterEach(() => vi.useRealTimers());
  const setup = () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    // What reads sessions is asked again once per invalidateSessions; the badges only when one moved.
    const reset = () => {
      for (const projectId of ["p", "q"]) {
        qc.setQueryData(keys.codeLink.recentSessions(projectId), []);
        qc.setQueryData(keys.badges(projectId), []);
      }
    };
    reset();
    const heard = sessionsRefresher(qc);
    const asked = () => {
      const asks = ["p", "q"].filter((projectId) => qc.getQueryState(keys.codeLink.recentSessions(projectId))?.isInvalidated).map((projectId) => ({ projectId, badges: !!qc.getQueryState(keys.badges(projectId))?.isInvalidated }));
      reset();
      return asks;
    };
    return { heard, asked };
  };

  it("asks again once for activity, after it settles, and then at most once a gap while it keeps coming", () => {
    const { heard, asked } = setup();
    heard("p", false);
    heard("p", false);
    expect(asked()).toEqual([]);
    vi.advanceTimersByTime(SESSIONS_SETTLE_MS);
    expect(asked()).toEqual([{ projectId: "p", badges: false }]);
    // Six a second for three seconds: one ask a gap, never two inside one, the last for the burst's tail.
    const times: number[] = [];
    for (let i = 0; i < 18; i++) {
      heard("p", false);
      for (let ms = 0; ms < 1000 / 6; ms += 10) {
        vi.advanceTimersByTime(10);
        if (asked().length) times.push(Date.now());
      }
    }
    vi.advanceTimersByTime(SESSIONS_GAP_MS);
    if (asked().length) times.push(Date.now());
    expect(times.length).toBe(3);
    expect(times.slice(1).every((at, i) => at - times[i] >= SESSIONS_GAP_MS)).toBe(true);
    vi.advanceTimersByTime(10 * SESSIONS_GAP_MS);
    expect(asked()).toEqual([]);
  });

  it("asks again at once when a session's standing changed, taking a pending activity ask along", () => {
    const { heard, asked } = setup();
    heard("p", false);
    heard("p", true);
    expect(asked()).toEqual([{ projectId: "p", badges: true }]);
    vi.advanceTimersByTime(10 * SESSIONS_GAP_MS);
    expect(asked()).toEqual([]);
  });

  it("asks for standing changes in quick succession within the settle, and keeps each project apart", () => {
    const { heard, asked } = setup();
    heard("p", true);
    heard("q", false);
    expect(asked()).toEqual([{ projectId: "p", badges: true }]);
    heard("p", true);
    heard("p", false);
    heard("p", true);
    expect(asked()).toEqual([]);
    vi.advanceTimersByTime(SESSIONS_SETTLE_MS);
    expect(asked()).toEqual([{ projectId: "p", badges: true }, { projectId: "q", badges: false }]);
    // Activity right after a standing change waits out the gap: the standing change already showed it.
    heard("p", false);
    vi.advanceTimersByTime(SESSIONS_GAP_MS - 1);
    expect(asked()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(asked()).toEqual([{ projectId: "p", badges: false }]);
  });
});
