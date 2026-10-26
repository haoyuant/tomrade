import type { Board, Repo } from "@tomradex/domain";
import type { CheckoutView } from "@tomradex/repos";

/**
 * Two spellings of one repository read the same, so a checkout keyed by URL is
 * found from any of them. Mirrors `normalizeRemote` in @tomradex/repos, which
 * the renderer cannot import (it pulls in node).
 */
export const normalizeRemote = (remote: string): string => remote.trim().replace(/\/\/[^@/]*@/, "//").replace(/\/+$/, "").replace(/\.git$/, "");

/** Workstreams whose repository has no usable folder on this machine: none placed, or the one placed is gone or no longer a repository. */
export function unplacedWorkstreams(boards: Board[], repos: Repo[], checkouts: CheckoutView[]): { board: Board; repo: Repo }[] {
  const byRemote = new Map(checkouts.map((c) => [c.remote, c]));
  return boards.flatMap((board) => {
    const repo = board.repoId ? repos.find((r) => r.id === board.repoId) : undefined;
    if (!repo) return [];
    const placed = byRemote.get(normalizeRemote(repo.remote));
    return placed?.checkout && !placed.problem ? [] : [{ board, repo }];
  });
}
