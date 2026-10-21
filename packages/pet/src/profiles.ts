import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ImageBox } from "@tomradex/contributions";
import { PET_MOODS, type PetMood } from "./state.js";

export const DEFAULT_PROFILE = "default";
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_NAME_LENGTH = 40;
const PROFILE_ID = /^p-[a-f0-9]{8}$/;

interface PetImage {
  file: string;
  type: string;
  box?: ImageBox;
  bytes: number;
}

export interface PetProfile {
  id: string;
  name: string;
  pixelated: boolean;
  createdAt: number;
  images: Partial<Record<PetMood, PetImage>>;
}

export interface PetProfileView {
  id: string;
  /** Empty for the built-in pet, whose name the renderer localises. */
  name: string;
  builtIn: boolean;
  pixelated: boolean;
  /** Moods with the profile's own image; the rest show the built-in pet's. */
  custom: PetMood[];
}

export interface PetProfilesView {
  active: string;
  /** False when no local folder is configured: only the built-in pet exists. */
  canSave: boolean;
  /** The states a profile can give an image, in display order. */
  moods: PetMood[];
  maxImageBytes: number;
  profiles: PetProfileView[];
}

export interface PetImageUpload {
  base64: string;
  /** Measured by the renderer that decoded the image; only a drawing hint here. */
  box?: ImageBox;
}

export interface ResolvedImage {
  path: string;
  type: string;
  box?: ImageBox;
  pixelated: boolean;
  custom: boolean;
}

const EXTENSION: Record<string, string> = { "image/gif": "gif", "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/avif": "avif" };

/** The type is read from the bytes, never taken from the file name or the sender. */
export function sniffImage(bytes: Buffer): string | null {
  const ascii = (from: number, to: number) => bytes.subarray(from, to).toString("latin1");
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") return "image/gif";
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(4, 8) === "ftyp" && (ascii(8, 12) === "avif" || ascii(8, 12) === "avis")) return "image/avif";
  return null;
}

const cleanBox = (box: ImageBox | undefined): ImageBox | undefined => {
  if (!box) return undefined;
  const ok = (n: unknown, min: number) => typeof n === "number" && Number.isInteger(n) && n >= min && n <= 16_384;
  return ok(box.x, 0) && ok(box.y, 0) && ok(box.width, 1) && ok(box.height, 1) ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined;
};

const cleanName = (name: string): string => {
  const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
  if (!trimmed) throw new Error("A pet needs a name");
  return trimmed;
};

const writeJson = (file: string, value: unknown) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
};

/**
 * Pets made from the user's own images: one folder per profile under this
 * machine's data folder, never synced. The built-in pet lives in the package,
 * is not stored here and cannot be changed or removed.
 */
export class PetProfiles {
  /** Bumped on every change, so cached renderings know to rebuild. */
  revision = 0;

  constructor(
    private readonly dir: string | null,
    private readonly builtIn: Record<PetMood, { path: string; type: string }>
  ) {}

  view(): PetProfilesView {
    const builtIn: PetProfileView = { id: DEFAULT_PROFILE, name: "", builtIn: true, pixelated: false, custom: [] };
    const custom = this.all().map((p): PetProfileView => ({ id: p.id, name: p.name, builtIn: false, pixelated: p.pixelated, custom: PET_MOODS.filter((m) => p.images[m]) }));
    return { active: this.activeId(), canSave: this.dir !== null, moods: [...PET_MOODS], maxImageBytes: MAX_IMAGE_BYTES, profiles: [builtIn, ...custom] };
  }

  activeId(): string {
    const active = this.index().active;
    return active && this.read(active) ? active : DEFAULT_PROFILE;
  }

  activate(id: string): void {
    if (id !== DEFAULT_PROFILE) this.require(id);
    this.writeIndex({ active: id });
  }

  create(name: string): PetProfile {
    const root = this.root();
    let id: string;
    do id = `p-${randomBytes(4).toString("hex")}`;
    while (fs.existsSync(path.join(root, id)));
    const profile: PetProfile = { id, name: cleanName(name), pixelated: false, createdAt: Date.now(), images: {} };
    fs.mkdirSync(path.join(root, id), { recursive: true });
    this.save(profile);
    return profile;
  }

  update(id: string, patch: { name?: string; pixelated?: boolean }): PetProfile {
    const profile = this.require(id);
    if (patch.name !== undefined) profile.name = cleanName(patch.name);
    if (patch.pixelated !== undefined) profile.pixelated = Boolean(patch.pixelated);
    this.save(profile);
    return profile;
  }

  remove(id: string): void {
    this.require(id);
    fs.rmSync(path.join(this.root(), id), { recursive: true, force: true });
    if (this.index().active === id) this.writeIndex({ active: DEFAULT_PROFILE });
    this.revision++;
  }

  setImage(id: string, mood: PetMood, upload: PetImageUpload): PetProfile {
    const profile = this.require(id);
    if (!PET_MOODS.includes(mood)) throw new Error(`Unknown pet state "${mood}"`);
    const bytes = Buffer.from(upload.base64, "base64");
    if (!bytes.length) throw new Error("The image is empty");
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`Images can be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    const type = sniffImage(bytes);
    if (!type) throw new Error("Use a GIF, WebP, PNG, JPEG or AVIF image");
    // A new name per upload, so anything caching the old file by its URL sees the change.
    const file = `${mood}-${Date.now().toString(36)}.${EXTENSION[type]}`;
    fs.writeFileSync(path.join(this.root(), id, file), bytes);
    this.dropFile(profile, mood);
    const box = cleanBox(upload.box);
    profile.images[mood] = { file, type, bytes: bytes.length, ...(box ? { box } : {}) };
    this.save(profile);
    return profile;
  }

  clearImage(id: string, mood: PetMood): PetProfile {
    const profile = this.require(id);
    this.dropFile(profile, mood);
    delete profile.images[mood];
    this.save(profile);
    return profile;
  }

  /** What each mood shows for a profile: its own image where it has one, the built-in pet's otherwise. */
  resolve(id: string): Record<PetMood, ResolvedImage> {
    const profile = id === DEFAULT_PROFILE ? null : this.read(id);
    return Object.fromEntries(
      PET_MOODS.map((mood) => {
        const own = profile?.images[mood];
        const image: ResolvedImage = own
          ? { path: path.join(this.root(), profile!.id, path.basename(own.file)), type: own.type, box: own.box, pixelated: profile!.pixelated, custom: true }
          : { ...this.builtIn[mood], pixelated: false, custom: false };
        return [mood, image];
      })
    ) as Record<PetMood, ResolvedImage>;
  }

  private all(): PetProfile[] {
    if (!this.dir || !fs.existsSync(this.dir)) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => PROFILE_ID.test(name))
      .map((name) => this.read(name))
      .filter((p): p is PetProfile => p !== null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private read(id: string): PetProfile | null {
    if (!this.dir || !PROFILE_ID.test(id)) return null;
    try {
      const profile = JSON.parse(fs.readFileSync(path.join(this.dir, id, "profile.json"), "utf8")) as PetProfile;
      return profile.id === id ? { ...profile, images: profile.images ?? {} } : null;
    } catch {
      return null;
    }
  }

  private require(id: string): PetProfile {
    if (id === DEFAULT_PROFILE) throw new Error("The built-in pet can't be changed or removed");
    const profile = this.read(id);
    if (!profile) throw new Error(`No pet "${id}"`);
    return profile;
  }

  private root(): string {
    if (!this.dir) throw new Error("No local folder for pets is configured");
    fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  private save(profile: PetProfile): void {
    writeJson(path.join(this.root(), profile.id, "profile.json"), profile);
    this.revision++;
  }

  private dropFile(profile: PetProfile, mood: PetMood): void {
    const old = profile.images[mood];
    if (old) fs.rmSync(path.join(this.root(), profile.id, path.basename(old.file)), { force: true });
  }

  private index(): { active?: string } {
    if (!this.dir) return {};
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, "profiles.json"), "utf8")) as { active?: string };
    } catch {
      return {};
    }
  }

  private writeIndex(index: { active: string }): void {
    writeJson(path.join(this.root(), "profiles.json"), index);
    this.revision++;
  }
}
