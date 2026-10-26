import { expect, it } from "vitest";
import type { Board, Repo } from "@tomradex/domain";
import { unplacedWorkstreams } from "../src/lib/remotes";

const board = (id: string, repoId: string | null): Board => ({ id, projectId: "p", name: id, icon: "", note: null, rank: 0, repoId, repoPath: "", createdAt: 0, updatedAt: 0 });
const repo = (id: string, remote: string): Repo => ({ id, projectId: "p", remote, name: id, defaultBranch: "main", createdAt: 0, updatedAt: 0 });

it("names the workstreams whose repository has no usable folder on this machine", () => {
  const repos = [repo("app", "https://github.com/acme/app"), repo("web", "https://github.com/acme/web"), repo("api", "https://github.com/acme/api"), repo("cli", "https://github.com/acme/cli")];
  const boards = [board("ui", "app"), board("site", "web"), board("server", "api"), board("tools", "cli"), board("notes", null)];
  const checkouts = [
    { remote: "https://github.com/acme/app", checkout: "C:\\code\\app", runInCheckout: false },
    { remote: "https://github.com/acme/api", checkout: "C:\\code\\api", runInCheckout: false, problem: "missing" as const },
    { remote: "https://github.com/acme/cli", checkout: "C:\\code\\cli", runInCheckout: false, problem: "not-git" as const }
  ];
  expect(unplacedWorkstreams(boards, repos, checkouts).map((u) => u.board.id)).toEqual(["site", "server", "tools"]);
  // Another spelling of the same remote still finds its folder.
  expect(unplacedWorkstreams(boards, [repo("app", "https://github.com/acme/app.git")], checkouts)).toEqual([]);
});
