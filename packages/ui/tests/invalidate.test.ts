import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateWorkspace } from "../src/lib/queries/invalidate";
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
