import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export interface MediaRef { id: string; name: string; mime: string; size: number; source?: MediaRef }
export interface MediaUpload { name: string; mime: string; base64: string }
export interface MediaContent extends MediaRef { base64: string }
export const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const MIME = /^(image\/(png|jpeg|gif|webp|svg\+xml)|audio\/(mpeg|wav|x-wav|ogg|webm|mp4)|video\/(mp4|webm)|text\/html|application\/pdf|application\/json)$/;

/** Conversation assets survive restart independently of a user's Files library. */
export class AgentMediaStore {
  constructor(private readonly root: string) {}
  private directory(projectId: string, threadId: string) {
    const scope = createHash("sha256").update(JSON.stringify([projectId, threadId])).digest("hex");
    return path.join(this.root, scope);
  }
  private entry(projectId: string, threadId: string, id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid media reference");
    return path.join(this.directory(projectId, threadId), id);
  }
  add(projectId: string, threadId: string, upload: MediaUpload): MediaRef {
    if (!MIME.test(upload.mime)) throw new Error("Unsupported media type");
    if (!upload.name || upload.name.length > 255) throw new Error("Invalid media name");
    if (upload.base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4 || /[^A-Za-z0-9+/=]/.test(upload.base64)) throw new Error("Invalid or oversized media");
    const bytes = Buffer.from(upload.base64, "base64");
    if (bytes.toString("base64") !== upload.base64) throw new Error("Invalid base64 media");
    if (!bytes.length || bytes.length > MAX_MEDIA_BYTES) throw new Error("Media must be nonempty and at most 32 MiB");
    const ref = { id: randomUUID(), name: path.basename(upload.name), mime: upload.mime, size: bytes.length };
    fs.mkdirSync(this.directory(projectId, threadId), { recursive: true });
    const entry = this.entry(projectId, threadId, ref.id);
    fs.writeFileSync(entry, bytes, { flag: "wx" });
    fs.writeFileSync(entry + ".json", JSON.stringify(ref), { flag: "wx" });
    return ref;
  }
  reference(projectId: string, threadId: string, id: string): MediaRef {
    return JSON.parse(fs.readFileSync(this.entry(projectId, threadId, id) + ".json", "utf8"));
  }
  read(projectId: string, threadId: string, id: string): MediaContent {
    const ref = this.reference(projectId, threadId, id);
    return { ...ref, base64: fs.readFileSync(this.entry(projectId, threadId, id)).toString("base64") };
  }
  localPath(projectId: string, threadId: string, id: string): string {
    const ref = this.reference(projectId, threadId, id);
    const extension: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "application/pdf": "pdf" };
    const source = this.entry(projectId, threadId, id);
    const target = `${source}.${extension[ref.mime] ?? "bin"}`;
    try { fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return target;
  }
  removeThread(projectId: string, threadId: string): void {
    fs.rmSync(this.directory(projectId, threadId), { recursive: true, force: true });
  }
}
