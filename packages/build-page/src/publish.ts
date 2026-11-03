import { errorMessage } from "@tomradex/contracts";
import { GENERATOR } from "./page.js";

/** The REST calls publishing needs, as `ctx.github.api` makes them. */
export interface Api {
  request<T>(method: string, route: string, body?: unknown): Promise<T>;
}

export const BRANCH = "gh-pages";

const status = (error: unknown) => (error as { status?: number }).status;

async function orNull<T>(call: Promise<T>): Promise<T | null> {
  try {
    return await call;
  } catch (error) {
    if (status(error) === 404) return null;
    throw error;
  }
}

export type PublishOutcome =
  | { ok: true; url: string | null; commit: string; pages: "served" | "enabled" }
  | { ok: true; url: string | null; commit: string; pages: "elsewhere"; source: string }
  | { ok: true; url: null; commit: string; pages: "failed"; why: string }
  | { ok: false; reason: "foreign" };

interface PagesSite {
  html_url?: string;
  build_type?: string;
  source?: { branch: string; path: string };
}

/**
 * Writes `files` onto the repository's gh-pages branch through the Git Data
 * API, keeping whatever else the branch holds, then makes sure GitHub Pages
 * serves that branch. A gh-pages index that Tomrade did not write is left alone.
 */
export async function publishPages(api: Api, repo: string, files: Record<string, string>, message: string): Promise<PublishOutcome> {
  const head = await orNull(api.request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${BRANCH}`));
  let baseTree: string | null = null;
  if (head) {
    const index = await orNull(api.request<{ content?: string; encoding?: string }>("GET", `/repos/${repo}/contents/index.html?ref=${BRANCH}`));
    const text = index?.content && index.encoding === "base64" ? Buffer.from(index.content, "base64").toString("utf8") : "";
    if (index && !text.includes(`content="${GENERATOR}"`)) return { ok: false, reason: "foreign" };
    baseTree = (await api.request<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${head.object.sha}`)).tree.sha;
  }
  const tree = [];
  for (const [path, text] of Object.entries(files)) {
    const blob = await api.request<{ sha: string }>("POST", `/repos/${repo}/git/blobs`, { content: Buffer.from(text, "utf8").toString("base64"), encoding: "base64" });
    tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
  }
  const made = await api.request<{ sha: string }>("POST", `/repos/${repo}/git/trees`, baseTree ? { base_tree: baseTree, tree } : { tree });
  const commit = await api.request<{ sha: string }>("POST", `/repos/${repo}/git/commits`, { message, tree: made.sha, parents: head ? [head.object.sha] : [] });
  if (head) await api.request("PATCH", `/repos/${repo}/git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  else await api.request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${BRANCH}`, sha: commit.sha });

  try {
    const site = await orNull(api.request<PagesSite>("GET", `/repos/${repo}/pages`));
    if (!site) {
      const made = await api.request<PagesSite>("POST", `/repos/${repo}/pages`, { source: { branch: BRANCH, path: "/" } });
      return { ok: true, url: made.html_url ?? null, commit: commit.sha, pages: "enabled" };
    }
    const served = site.build_type !== "workflow" && site.source?.branch === BRANCH && site.source.path === "/";
    if (served) return { ok: true, url: site.html_url ?? null, commit: commit.sha, pages: "served" };
    const source = site.build_type === "workflow" ? "GitHub Actions" : `${site.source?.branch ?? "?"}${site.source?.path ?? ""}`;
    return { ok: true, url: site.html_url ?? null, commit: commit.sha, pages: "elsewhere", source };
  } catch (error) {
    return { ok: true, url: null, commit: commit.sha, pages: "failed", why: errorMessage(error) };
  }
}
