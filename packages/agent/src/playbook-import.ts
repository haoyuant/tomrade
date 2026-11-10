import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ORIGIN_FILE, VERSIONS_DIR, frontmatter, playbookRequirements, readOrigin, type PlaybookOrigin } from "./playbooks.js";

/** One skill as read from its source: every file under its folder, by relative path. */
export interface SkillFiles {
  /** The folder name at the source, the fallback id. */
  name: string;
  files: Map<string, Buffer>;
}

export interface SkillPreview {
  id: string;
  title: string;
  when: string;
  files: string[];
}

export class PlaybookImportError extends Error {
  constructor(
    readonly code: "notFound" | "noSkill" | "invalid" | "tooLarge" | "unreachable" | "pick",
    message: string
  ) {
    super(message);
  }
}

const MAX_FILE_BYTES = 1_000_000;
const MAX_SKILL_BYTES = 5_000_000;
const MAX_FILES = 200;
const MAX_SKILLS = 30;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const SKIP = new Set([".git", "node_modules", VERSIONS_DIR, ORIGIN_FILE, ".DS_Store"]);

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

interface GithubPlace {
  owner: string;
  repo: string;
  ref?: string;
  /** A folder in the repository, "" for its root. */
  dir: string;
  /** From a skills.sh page: the skill's folder name somewhere in the repository. */
  skill?: string;
}

/** What a source string points at: a folder on this machine, a GitHub repository (directly, via raw or skills.sh), or one SKILL.md at a URL. */
export function parseSource(source: string): { kind: "local"; dir: string } | { kind: "github"; place: GithubPlace } | { kind: "url"; url: string } {
  const text = source.trim();
  if (!/^https?:\/\//i.test(text)) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const dir = text.startsWith("~") ? path.join(home, text.slice(1)) : text;
    return { kind: "local", dir: path.resolve(dir.replace(/[\\/]SKILL\.md$/i, "")) };
  }
  const url = new URL(text);
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const host = url.hostname.toLowerCase();
  const fileToDir = (rest: string[]) => (/^SKILL\.md$/i.test(rest[rest.length - 1] ?? "") ? rest.slice(0, -1) : rest).join("/");
  if ((host === "github.com" || host === "www.github.com") && parts.length >= 2) {
    const [owner, repo, mode, ref, ...rest] = parts;
    const name = repo.replace(/\.git$/, "");
    if ((mode === "tree" || mode === "blob") && ref) return { kind: "github", place: { owner, repo: name, ref, dir: fileToDir(rest) } };
    return { kind: "github", place: { owner, repo: name, dir: "" } };
  }
  if (host === "raw.githubusercontent.com" && parts.length >= 4) {
    const [owner, repo, ref, ...rest] = parts;
    return { kind: "github", place: { owner, repo, ref, dir: fileToDir(rest) } };
  }
  if ((host === "skills.sh" || host === "www.skills.sh") && parts.length >= 2 && parts[0] !== "site") {
    const [owner, repo, skill] = parts;
    return { kind: "github", place: { owner, repo, dir: "", skill } };
  }
  return { kind: "url", url: text };
}

/** Reads every skill the source holds; `fetchImpl` is for tests. Nothing is written. */
export async function readSkills(source: string, fetchImpl: Fetch = globalThis.fetch as unknown as Fetch): Promise<SkillFiles[]> {
  const parsed = parseSource(source);
  if (parsed.kind === "local") return readLocal(parsed.dir);
  if (parsed.kind === "url") {
    const res = await get(fetchImpl, parsed.url);
    const body = Buffer.from(await res.arrayBuffer());
    if (body.byteLength > MAX_FILE_BYTES) throw new PlaybookImportError("tooLarge", `${parsed.url} is over ${MAX_FILE_BYTES} bytes`);
    const name = path.basename(new URL(parsed.url).pathname).replace(/\.md$/i, "");
    return [{ name: /^skill$/i.test(name) ? "imported" : name, files: new Map([["SKILL.md", body]]) }];
  }
  return readGithub(parsed.place, fetchImpl);
}

function readLocal(dir: string): SkillFiles[] {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new PlaybookImportError("notFound", `${dir} is not a folder`);
  if (fs.existsSync(path.join(dir, "SKILL.md"))) return [readLocalSkill(dir)];
  const skills = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && fs.existsSync(path.join(dir, e.name, "SKILL.md")))
    .map((e) => readLocalSkill(path.join(dir, e.name)));
  if (!skills.length) throw new PlaybookImportError("noSkill", `no SKILL.md in ${dir} or its subfolders`);
  return skills;
}

function readLocalSkill(dir: string): SkillFiles {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (at: string, rel: string) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue;
      // Links could reach anywhere on the machine; only the folder's own files travel.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(at, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, relPath);
      else if (entry.isFile()) {
        const data = fs.readFileSync(full);
        total += data.byteLength;
        if (data.byteLength > MAX_FILE_BYTES || total > MAX_SKILL_BYTES || files.size >= MAX_FILES) throw new PlaybookImportError("tooLarge", `${dir} holds too much to import as one playbook`);
        files.set(relPath, data);
      }
    }
  };
  walk(dir, "");
  return { name: path.basename(dir), files };
}

async function get(fetchImpl: Fetch, url: string, headers?: Record<string, string>) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { "user-agent": "Tomrade", ...headers } });
  } catch (err) {
    throw new PlaybookImportError("unreachable", `${url}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status === 404) throw new PlaybookImportError("notFound", `${url} was not found (or is private)`);
  if (!res.ok) throw new PlaybookImportError("unreachable", `${url} answered ${res.status}${res.status === 403 || res.status === 429 ? " (rate limited — try again later)" : ""}`);
  return res;
}

async function readGithub(place: GithubPlace, fetchImpl: Fetch): Promise<SkillFiles[]> {
  const api = `https://api.github.com/repos/${place.owner}/${place.repo}`;
  const accept = { accept: "application/vnd.github+json" };
  const ref = place.ref ?? ((await (await get(fetchImpl, api, accept)).json()) as { default_branch?: string }).default_branch ?? "main";
  const tree = (await (await get(fetchImpl, `${api}/git/trees/${encodeURIComponent(ref)}?recursive=1`, accept)).json()) as { tree?: { path: string; type: string; size?: number }[] };
  const blobs = (tree.tree ?? []).filter((e) => e.type === "blob");
  const under = (dir: string) => (p: string) => !dir || p === dir || p.startsWith(`${dir}/`);
  const skillFile = (p: string) => p === "SKILL.md" || p.endsWith("/SKILL.md");
  let dirs = blobs.map((b) => b.path).filter((p) => skillFile(p) && under(place.dir)(p)).map((p) => path.posix.dirname(p).replace(/^\.$/, ""));
  if (place.skill) dirs = dirs.filter((d) => path.posix.basename(d) === place.skill).sort((a, b) => a.length - b.length).slice(0, 1);
  else if (dirs.includes(place.dir)) dirs = [place.dir];
  // A skill's own folder may carry examples that are skills too; those belong to it.
  dirs = dirs.filter((d) => !dirs.some((o) => o !== d && (o === "" || d.startsWith(`${o}/`))));
  if (!dirs.length) throw new PlaybookImportError("noSkill", `no SKILL.md in ${place.owner}/${place.repo}${place.dir ? `/${place.dir}` : ""}${place.skill ? ` for "${place.skill}"` : ""}`);
  if (dirs.length > MAX_SKILLS) throw new PlaybookImportError("pick", `${place.owner}/${place.repo} holds ${dirs.length} skills — point at one folder instead`);
  const out: SkillFiles[] = [];
  for (const dir of dirs) {
    const mine = blobs.filter((b) => under(dir)(b.path) && !b.path.split("/").some((seg) => SKIP.has(seg)));
    const total = mine.reduce((s, b) => s + (b.size ?? 0), 0);
    if (mine.length > MAX_FILES || total > MAX_SKILL_BYTES || mine.some((b) => (b.size ?? 0) > MAX_FILE_BYTES)) throw new PlaybookImportError("tooLarge", `${dir || place.repo} holds too much to import as one playbook`);
    const files = new Map<string, Buffer>();
    for (const blob of mine) {
      const raw = `https://raw.githubusercontent.com/${place.owner}/${place.repo}/${encodeURIComponent(ref)}/${blob.path.split("/").map(encodeURIComponent).join("/")}`;
      files.set(dir ? blob.path.slice(dir.length + 1) : blob.path, Buffer.from(await (await get(fetchImpl, raw)).arrayBuffer()));
    }
    out.push({ name: dir ? path.posix.basename(dir) : place.repo, files });
  }
  return out;
}

/** The playbook a skill becomes, or why it cannot be one. */
export function validateSkill(skill: SkillFiles): SkillPreview {
  const raw = skill.files.get("SKILL.md");
  if (!raw) throw new PlaybookImportError("invalid", `${skill.name}: no SKILL.md`);
  let meta: Record<string, unknown>;
  let body: string;
  try {
    ({ meta, body } = frontmatter(raw.toString("utf8")));
    playbookRequirements(meta);
  } catch (err) {
    throw new PlaybookImportError("invalid", `${skill.name}/SKILL.md: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
  }
  const id = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : skill.name;
  if (!ID.test(id)) throw new PlaybookImportError("invalid", `${skill.name}/SKILL.md: "${id}" cannot be a playbook id (letters, digits, dot, dash, underscore)`);
  if (typeof meta.description !== "string" || !meta.description.trim()) throw new PlaybookImportError("invalid", `${skill.name}/SKILL.md: its frontmatter has no description, which says when the playbook applies`);
  if (!body) throw new PlaybookImportError("invalid", `${skill.name}/SKILL.md: the body is empty`);
  for (const rel of skill.files.keys()) {
    if (rel.split("/").some((seg) => seg === ".." || seg === "") || path.isAbsolute(rel)) throw new PlaybookImportError("invalid", `${skill.name}: unsafe path ${rel}`);
  }
  return { id, title: typeof meta.title === "string" ? meta.title : id, when: meta.description.trim(), files: [...skill.files.keys()].sort() };
}

/** The version numbers kept under `<dir>/.versions`, oldest first. */
export function keptVersions(dir: string): number[] {
  const at = path.join(dir, VERSIONS_DIR);
  if (!fs.existsSync(at)) return [];
  return fs
    .readdirSync(at)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
    .sort((a, b) => a - b);
}

/**
 * Writes `files` as playbook `id` under `root`. Everything lands in a scratch
 * folder first, so a failure leaves nothing half-written; an existing playbook
 * of that id moves into the new one's `.versions/<n>` instead of being lost.
 */
export function installPlaybook(root: string, id: string, files: Map<string, Buffer>, origin: Omit<PlaybookOrigin, "version">): { id: string; version: number; replaced: boolean } {
  fs.mkdirSync(root, { recursive: true });
  const dest = path.join(root, id);
  const scratch = path.join(root, `.import-${randomUUID()}`);
  const existing = fs.existsSync(dest);
  const version = existing ? Math.max(readOrigin(dest)?.version ?? 1, ...keptVersions(dest)) + 1 : 1;
  try {
    for (const [rel, data] of files) {
      const file = path.join(scratch, ...rel.split("/"));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, data);
    }
    fs.writeFileSync(path.join(scratch, ORIGIN_FILE), `${JSON.stringify({ ...origin, version }, null, 2)}\n`);
    if (existing) {
      const kept = path.join(dest, VERSIONS_DIR);
      if (fs.existsSync(kept)) fs.renameSync(kept, path.join(scratch, VERSIONS_DIR));
      else fs.mkdirSync(path.join(scratch, VERSIONS_DIR));
      fs.renameSync(dest, path.join(scratch, VERSIONS_DIR, String(version - 1)));
    }
    fs.renameSync(scratch, dest);
  } catch (err) {
    // Put back what was there before, then drop the scratch folder.
    const previous = path.join(scratch, VERSIONS_DIR, String(version - 1));
    if (existing && !fs.existsSync(dest) && fs.existsSync(previous)) {
      fs.renameSync(previous, dest);
      const kept = path.join(scratch, VERSIONS_DIR);
      if (fs.readdirSync(kept).length) fs.renameSync(kept, path.join(dest, VERSIONS_DIR));
    }
    fs.rmSync(scratch, { recursive: true, force: true });
    throw err;
  }
  return { id, version, replaced: existing };
}

/** Undoes the last install of `id`: the previous version comes back, or the playbook goes when it had none. */
export function uninstallLatest(root: string, id: string): void {
  const dest = path.join(root, id);
  if (!fs.existsSync(dest)) return;
  const versions = keptVersions(dest);
  if (!versions.length) {
    fs.rmSync(dest, { recursive: true, force: true });
    return;
  }
  const latest = versions[versions.length - 1];
  const gone = path.join(root, `.undo-${randomUUID()}`);
  fs.renameSync(dest, gone);
  fs.renameSync(path.join(gone, VERSIONS_DIR, String(latest)), dest);
  if (versions.length > 1) fs.renameSync(path.join(gone, VERSIONS_DIR), path.join(dest, VERSIONS_DIR));
  fs.rmSync(gone, { recursive: true, force: true });
}
