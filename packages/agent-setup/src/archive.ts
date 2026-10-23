import fs from "node:fs";
import path from "node:path";
import { crc32, inflateRawSync } from "node:zlib";
import type { EngineSetupFailure } from "@tomradex/agent";

/**
 * An agent that ships as a zip of standalone binaries, installed without Node,
 * npm or a shell installer: Tomrade downloads the zip for this machine and
 * unpacks the one file the plugin names into a folder of its own. The zip is
 * read here, not with `unzip` or `tar`, which Windows has neither of.
 */

/** A failure with the kind a setup screen words, and the tool's own words beneath. */
export class ArchiveError extends Error {
  constructor(readonly kind: EngineSetupFailure["kind"], message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

interface Entry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/** Where each file in a zip starts, from its central directory — the one place every writer records it. */
export function listZip(buffer: Buffer): Entry[] {
  const bad = () => new ArchiveError("exit", "the downloaded file is not a zip archive — check that the address still offers the release");
  const min = Math.max(0, buffer.length - 66_000);
  let eocd = -1;
  for (let at = buffer.length - 22; at >= min; at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw bad();
  const count = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== 0x02014b50) throw bad();
    const nameLength = buffer.readUInt16LE(at + 28);
    entries.push({
      name: buffer.toString("utf8", at + 46, at + 46 + nameLength),
      method: buffer.readUInt16LE(at + 10),
      crc: buffer.readUInt32LE(at + 16),
      compressedSize: buffer.readUInt32LE(at + 20),
      size: buffer.readUInt32LE(at + 24),
      localOffset: buffer.readUInt32LE(at + 42)
    });
    at += 46 + nameLength + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return entries;
}

/** One entry's bytes, inflated when the writer compressed it. */
function readEntry(buffer: Buffer, entry: Entry): Buffer {
  const bad = () => new ArchiveError("exit", `the archive's copy of ${entry.name} is damaged — download it again`);
  const at = entry.localOffset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) throw bad();
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const data = buffer.subarray(start, start + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw bad();
  if (entry.method === 0) return data;
  if (entry.method !== 8) throw new ArchiveError("unsupported", `the archive compresses ${entry.name} in a way Tomrade cannot read (method ${entry.method}) — the agent's plugin needs a plain zip`);
  try {
    return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
  } catch {
    throw bad();
  }
}

/** A file's name inside an archive, matched as written: `server` before whole segments, case kept. */
export const entryNamed = (entries: Entry[], file: string): Entry | undefined => {
  const want = file.replace(/\\/g, "/").replace(/^\.?\//, "");
  return entries.find((entry) => entry.name === want) ?? entries.find((entry) => entry.name.replace(/^\.?\//, "") === want);
};

/**
 * Where an archive install puts its file: under Tomrade's own data folder,
 * one folder per engine and version, `bin/` inside — so a new version never
 * unpacks over a running one, and nothing lands in a system path.
 */
export const archiveDir = (root: string, engineId: string, url: string): string =>
  path.join(root, engineId.replace(/[^\w.-]/g, "_"), path.basename(new URL(url).pathname).replace(/\.zip$/i, ""));

export interface ArchiveTarget {
  /** The folder the file is unpacked into. */
  dir: string;
  /** The absolute path of the file the plugin named, as it lands there. */
  file: string;
}

/** Take exactly `file` out of the zip bytes and write it to `target`, executable on macOS and Linux. */
export function unpackArchive(buffer: Buffer, file: string, target: ArchiveTarget, platform: NodeJS.Platform): ArchiveTarget {
  let entry: Entry | undefined;
  try {
    entry = entryNamed(listZip(buffer), file);
  } catch (error) {
    if (error instanceof ArchiveError) throw new ArchiveError(error.kind, error.message);
    throw new ArchiveError("exit", `the downloaded file could not be read as a zip: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!entry) throw new ArchiveError("not-found", `the archive downloaded but has no ${file} in it — the agent's plugin names a file the release does not ship`);
  if (entry.size > MAX_ENTRY_BYTES) throw new ArchiveError("disk-full", `${file} in the archive is larger than Tomrade unpacks (${Math.round(MAX_ENTRY_BYTES / 1024 / 1024)} MB)`);
  const bytes = readEntry(buffer, entry);
  if (crc32(bytes) !== entry.crc) throw new ArchiveError("exit", `${file} did not come out of the archive intact — download it again`);
  const name = path.basename(file.replace(/\\/g, "/"));
  const at = path.join(target.dir, name);
  try {
    fs.mkdirSync(target.dir, { recursive: true });
    fs.writeFileSync(at, bytes);
    if (platform !== "win32") fs.chmodSync(at, 0o755);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const kind = code === "ENOSPC" ? "disk-full" : code === "EACCES" || code === "EPERM" ? "permission" : "exit";
    throw new ArchiveError(kind, `could not write ${at}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { dir: target.dir, file: at };
}
