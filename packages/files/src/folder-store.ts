import fs from "node:fs";
import path from "node:path";
import { TREE_LIMIT, contentOf, normalizeRel, sha256 } from "./git-store.js";
import { FileChangedError, InvalidPathError, type FileContent, type FileEntry, type FileSearchHit, type FileSearchInput, type FileSearchResult, type FileStore, type FilesStatus, type WriteEntry } from "./types.js";

const SEARCH_LIMIT = 2 * 1024 * 1024;

/**
 * The files folder as it is, for a machine without git: every read and write
 * works on the folder itself; versions, undo and sharing wait until git is
 * there, and the next open then keeps the same folder under git.
 */
export class FolderFileStore implements FileStore {
  constructor(
    readonly dir: string,
    private readonly opts: { detail: string; onChange(paths?: string[]): void }
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private abs(rel: string): string {
    return path.join(this.dir, ...rel.split("/"));
  }

  private async readDir(rel: string): Promise<FileEntry[]> {
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(rel ? this.abs(rel) : this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const entries: FileEntry[] = [];
    for (const d of dirents) {
      if (d.name.startsWith(".") || d.name.endsWith(".tmp") || !(d.isFile() || d.isDirectory())) continue;
      const p = rel ? `${rel}/${d.name}` : d.name;
      try {
        const stat = fs.statSync(this.abs(p));
        entries.push({ path: p, name: d.name, kind: d.isDirectory() ? "dir" : "file", size: d.isDirectory() ? 0 : stat.size, modifiedAt: Math.round(stat.mtimeMs), fileId: null });
      } catch {
        // gone between readdir and stat
      }
    }
    return entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "dir" ? -1 : 1));
  }

  list(dir = ""): Promise<FileEntry[]> {
    return this.readDir(normalizeRel(dir));
  }

  async tree(): Promise<FileEntry[]> {
    const out: FileEntry[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await this.readDir(rel)) {
        if (out.length >= TREE_LIMIT) return;
        out.push(entry);
        if (entry.kind === "dir") await walk(entry.path);
      }
    };
    await walk("");
    return out;
  }

  async read(p: string): Promise<FileContent | null> {
    const rel = normalizeRel(p);
    if (!rel) return null;
    try {
      if (!fs.statSync(this.abs(rel)).isFile()) return null;
      return contentOf(rel, await fs.promises.readFile(this.abs(rel)), null, null);
    } catch {
      return null;
    }
  }

  async readVersion(): Promise<FileContent | null> {
    return null;
  }

  async resolveVersion(): Promise<null> {
    return null;
  }

  async locate(): Promise<string | null> {
    return null;
  }

  async history(): Promise<[]> {
    return [];
  }

  async write(p: string, body: Buffer, opts: { expect?: string | null } = {}): Promise<FileContent> {
    await this.writeMany([{ path: p, body, expect: opts.expect }]);
    const content = await this.read(p);
    if (!content) throw new Error(`${normalizeRel(p)} vanished while saving`);
    return content;
  }

  async writeMany(entries: WriteEntry[]): Promise<void> {
    const rels = entries.map((entry) => {
      const rel = normalizeRel(entry.path);
      if (!rel) throw new InvalidPathError(entry.path);
      const stat = fs.statSync(this.abs(rel), { throwIfNoEntry: false });
      if (stat?.isDirectory()) throw new Error(`${rel} is a folder`);
      if (entry.expect !== undefined && (stat?.isFile() ? sha256(fs.readFileSync(this.abs(rel))) : null) !== entry.expect) throw new FileChangedError(rel);
      return rel;
    });
    entries.forEach((entry, i) => {
      const abs = this.abs(rels[i]!);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = `${abs}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, entry.body);
      fs.renameSync(tmp, abs);
    });
    if (entries.length) this.opts.onChange(rels);
  }

  async mkdir(p: string): Promise<void> {
    const rel = normalizeRel(p);
    if (!rel) throw new InvalidPathError(p);
    if (fs.existsSync(this.abs(rel)) && !fs.statSync(this.abs(rel)).isDirectory()) throw new Error(`${rel} is a file`);
    fs.mkdirSync(this.abs(rel), { recursive: true });
    this.opts.onChange([rel]);
  }

  private pair(from: string, to: string, verb: "move" | "copy"): [string, string] {
    const src = normalizeRel(from);
    const dst = normalizeRel(to);
    if (!src || !dst) throw new InvalidPathError(src ? to : from);
    if (dst === src || dst.startsWith(`${src}/`)) throw new Error(`Cannot ${verb} ${src} into itself`);
    if (!fs.existsSync(this.abs(src))) throw new Error(`${src} does not exist`);
    if (fs.existsSync(this.abs(dst))) throw new Error(`${dst} already exists`);
    fs.mkdirSync(path.dirname(this.abs(dst)), { recursive: true });
    return [src, dst];
  }

  async move(from: string, to: string): Promise<void> {
    const [src, dst] = this.pair(from, to, "move");
    fs.renameSync(this.abs(src), this.abs(dst));
    this.opts.onChange([src, dst]);
  }

  async copy(from: string, to: string): Promise<void> {
    const [src, dst] = this.pair(from, to, "copy");
    fs.cpSync(this.abs(src), this.abs(dst), { recursive: true });
    this.opts.onChange([dst]);
  }

  async remove(p: string): Promise<void> {
    const rel = normalizeRel(p);
    if (!rel) throw new InvalidPathError(p);
    if (!fs.existsSync(this.abs(rel))) return;
    fs.rmSync(this.abs(rel), { recursive: true, force: true });
    this.opts.onChange([rel]);
  }

  async settle(): Promise<boolean> {
    return false;
  }

  /** A plain scan; literal unless asked, and a file too large to read whole is skipped. */
  async search(input: FileSearchInput): Promise<FileSearchResult> {
    const scope = input.path ? normalizeRel(input.path) : "";
    const glob = input.glob ? new RegExp(`^${input.glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, input.caseSensitive ? "" : "i") : null;
    const files = (await this.tree()).filter((e) => e.kind === "file" && e.size <= SEARCH_LIMIT && (!scope || e.path === scope || e.path.startsWith(`${scope}/`)) && (!glob || glob.test(e.name)));
    const hits: FileSearchHit[] = [];
    const truncated: string[] = [];
    for (const query of input.queries) {
      if (!query.trim()) continue;
      const pattern = new RegExp(input.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.caseSensitive ? "" : "i");
      let found = 0;
      scan: for (const file of files) {
        const content = await this.read(file.path);
        if (!content || content.encoding !== "utf8") continue;
        const lines = content.body.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (!pattern.test(lines[i]!)) continue;
          if (found >= input.max) {
            truncated.push(query);
            break scan;
          }
          found++;
          const text = lines[i]!.trim();
          hits.push({ query, path: file.path, line: i + 1, text: text.length > 200 ? `${text.slice(0, 200)}…` : text });
        }
      }
    }
    return { hits, truncated };
  }

  async status(): Promise<FilesStatus> {
    return { state: "local", location: this.dir, detail: this.opts.detail, lastSyncAt: null, conflicts: 0, ahead: 0, behind: 0, head: null, versionless: true };
  }

  sync(): Promise<FilesStatus> {
    return this.status();
  }

  async conflicts(): Promise<[]> {
    return [];
  }

  async resolve(): Promise<void> {
    throw new Error("Nothing is in conflict: these files are not shared");
  }

  close(): void {}
}
