import { describe, expect, it } from "vitest";
import { continuePrompt, firstPrompt } from "@tomradex/code-link";

describe("a ticket that answers a GitHub issue", () => {
  const body = "> From GitHub Issues · [acme/app#12](https://github.com/acme/app/issues/12) · by someone\n\nIt breaks.";
  const item = { key: "TOM-2", title: "Cart badge", body, status: "todo", labels: [], blockedBy: [], blocks: [] } as never;
  const repo = { name: "app", remote: "git@github.com:acme/app.git", defaultBranch: "main" } as never;
  const state = { hasBrief: true, readiness: "scaffolded", manifests: [] } as never;
  const base = { item, repo, state, branch: "tom-2/cart-badge", blockers: [], bootstrap: false, mcpUrl: null };

  it("tells the agent to reference the issue, never close it from the pull request", () => {
    for (const prompt of [firstPrompt(base), continuePrompt(item, repo, null, null)]) {
      expect(prompt).toContain('write "Refs acme/app#12", never Closes, Fixes or Resolves');
    }
    const plain = firstPrompt({ ...base, item: { ...(item as object), body: "No issue here." } as never });
    expect(plain).not.toContain("Refs ");
  });
});
