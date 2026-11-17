import type { Git } from "@tomradex/git";

/** What became of the checkout's default branch: moved to the remote's, nothing to move, or left alone with the reason. */
export type FollowOutcome = "moved" | "current" | "ahead" | "busy" | "dirty" | "refused";

/**
 * Bring the checkout's default branch to the remote's, as last fetched, when that is a fast-forward and loses nothing.
 * Where the branch is checked out, that folder's files follow it — only with no uncommitted change to a tracked file
 * and nobody at work there (`busy`). Checked out nowhere, only the branch moves. git refuses the rest: a branch in the
 * middle of a rebase, an untracked file that would be overwritten.
 */
export async function followDefault(git: Git, checkout: string, branch: string, busy: (dir: string) => boolean): Promise<FollowOutcome> {
  const run = (args: string[], cwd = checkout) => git(args, { cwd, ok: true });
  const local = `refs/heads/${branch}`;
  const remote = `refs/remotes/origin/${branch}`;
  // Fails when either is not there: then there is nothing to follow.
  const counts = await run(["rev-list", "--left-right", "--count", `${local}...${remote}`]);
  if (counts.code !== 0) return "current";
  const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
  if (!behind) return "current";
  // Commits of its own: bringing them together is the person's merge or rebase to make.
  if (ahead) return "ahead";
  const list = await run(["worktree", "list", "--porcelain"]);
  const holder = list.stdout.split(/\r?\n\r?\n+/).map((block) => block.split(/\r?\n/)).find((lines) => lines.includes(`branch ${local}`))?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
  if (!holder) return (await run(["fetch", "-q", ".", `${remote}:${local}`])).code === 0 ? "moved" : "refused";
  if (busy(holder)) return "busy";
  const status = await run(["--no-optional-locks", "status", "--porcelain", "--untracked-files=no"], holder);
  if (status.code !== 0 || status.stdout.trim()) return "dirty";
  return (await run(["merge", "-q", "--ff-only", remote], holder)).code === 0 ? "moved" : "refused";
}
