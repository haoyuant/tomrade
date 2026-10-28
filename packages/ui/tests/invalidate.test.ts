import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateSessions, invalidateWorkspace } from "../src/lib/queries/invalidate";
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
