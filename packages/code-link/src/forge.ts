import { remoteIdentity, sshHostName } from "@tomradex/repos";

/** What GitHub says about one pull request. */
export interface ForgePull {
  merged: boolean;
  state: "open" | "closed";
  /** The commit the merge made on its base (a squash's new commit); null until merged. */
  mergeSha: string | null;
  base: string;
}

/** `owner/repo` and number of a link's GitHub pull request: from its URL, else the repository's remote. */
export async function githubPull(prUrl: string | null, prNumber: number | null, remote: string): Promise<{ repo: string; number: number } | null> {
  const fromUrl = prUrl ? /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(prUrl) : null;
  if (fromUrl) return { repo: fromUrl[1]!, number: Number(fromUrl[2]) };
  if (prNumber === null) return null;
  const id = remoteIdentity(remote);
  if (!id || id.path.split("/").length !== 2) return null;
  // An SSH alias (`github.com-work`) stands for whatever its HostName says.
  const host = id.ssh ? await sshHostName(id.host) : id.host;
  return host === "github.com" ? { repo: id.path, number: prNumber } : null;
}

/** GitHub's REST answer for a pull request, or null when it is not one. */
export function readPull(raw: unknown): ForgePull | null {
  const pull = raw as { merged?: unknown; state?: unknown; merge_commit_sha?: unknown; base?: { ref?: unknown } } | null;
  if (!pull || (pull.state !== "open" && pull.state !== "closed")) return null;
  const merged = pull.merged === true;
  return {
    merged,
    state: pull.state,
    // An open pull request's merge_commit_sha is GitHub's trial merge, not anything on the base.
    mergeSha: merged && typeof pull.merge_commit_sha === "string" ? pull.merge_commit_sha : null,
    base: typeof pull.base?.ref === "string" ? pull.base.ref : ""
  };
}
