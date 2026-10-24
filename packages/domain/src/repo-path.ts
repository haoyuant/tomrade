/**
 * A workstream's folder in its repository. Stored relative to the repository
 * root with forward slashes, so one spelling serves every machine; the checkout
 * it lands in is this machine's alone and only known where an agent starts.
 */

const DRIVE = /^[a-zA-Z]:(?=\/|$)/;

const slashes = (raw: string) => raw.trim().replace(/\\/g, "/");

/**
 * The stored spelling: forward slashes, no doubled or trailing separators, ""
 * for the root. A leading slash (or a UNC `//`) stays: an absolute spelling
 * keeps its meaning until a checkout resolves it, and only then is it relative.
 */
export function normalizeRepoPath(raw: string): string {
  const p = slashes(raw);
  const unc = p.startsWith("//");
  const body = p.replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (body === "" || body === "/") return "";
  return unc ? `/${body}` : body;
}

/**
 * Whether a path names a place on a machine (`D:\…`, `\\server\…`) rather than
 * a folder inside the repository. A leading slash alone is not enough:
 * `/packages/ui` has long been read as `packages/ui`.
 */
export function isMachinePath(raw: string): boolean {
  const p = slashes(raw);
  return DRIVE.test(p) || p.startsWith("//");
}

/** The repository path spelled for display: the folder it means in the checkout when that is known, else the path without its leading slash. */
export function repoPathLabel(repoPath: string, checkout?: string | null): string {
  return (checkout ? repoSubfolder(repoPath, checkout) : null) ?? normalizeRepoPath(repoPath).replace(/^\/+/, "");
}

/**
 * The folder a repository path means inside a checkout, relative to it: a
 * relative path as is, an absolute path that lies in the checkout as the folder
 * it names (the checkout itself as the root), an absolute path elsewhere as null.
 * Drive letters compare case-insensitively, as Windows does.
 */
export function repoSubfolder(repoPath: string, checkout: string): string | null {
  const machine = isMachinePath(repoPath);
  const p = normalizeRepoPath(repoPath);
  const root = normalizeRepoPath(checkout);
  const relative = (s: string) => s.replace(/^\/+/, "");
  if (!machine && !p.startsWith("/")) return p;
  const fold = (s: string) => (DRIVE.test(s) || DRIVE.test(root) ? s.toLowerCase() : s);
  if (fold(p) === fold(root)) return "";
  if (fold(p).startsWith(`${fold(root)}/`)) return relative(p.slice(root.length + 1));
  // Only an unmistakable machine path is refused; a leading slash keeps its old relative reading.
  return machine ? null : relative(p);
}
