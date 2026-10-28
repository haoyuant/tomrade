import { describe, expect, it } from "vitest";
import { firstPrompt } from "@tomradex/code-link";

describe("CLAUDE.md in a first prompt", () => {
  const item = { key: "TOM-2", title: "Cart badge", body: null, status: "todo", labels: [], blockedBy: [], blocks: [] } as never;
  const repo = { name: "app", remote: "git@github.com:acme/app.git", defaultBranch: "main" } as never;
  const state = { hasBrief: false, readiness: "scaffolded", manifests: ["package.json"] } as never;
  const base = { item, repo, state, branch: "tom-2/cart-badge", blockers: [], bootstrap: false, mcpUrl: null };

  it("asks only the ticket that is first on the repository to add it", () => {
    expect(firstPrompt(base)).toContain("add a short CLAUDE.md as part of this work");
    const second = firstPrompt({ ...base, claudeMdBy: "TOM-1" });
    expect(second).toContain("leave CLAUDE.md alone — TOM-1 is adding it");
    expect(second).not.toContain("add a short CLAUDE.md");
  });
});
