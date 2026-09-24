import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { MANIFEST_FILE, nameOf, parseManifest, publisherOf, type Manifest } from "@tomrade/plugin-sdk";
import { listFiles, treeDigest } from "./digest.js";
import type { Attestation } from "./sign.js";

export const PACKAGE_EXT = ".tomrade-plugin";
/** Signs the digest of everything else, so it is never part of it. */
export const ATTESTATION_FILE = "ATTESTATION.json";

export const LIMITS = { packageBytes: 20 * 1024 * 1024, unpackedBytes: 60 * 1024 * 1024, files: 2_000 };

const SHIPPED = [/^dist\//, /^README(\.[a-z]+)?$/i, /^LICEN[CS]E(\.[a-z]+)?$/i, /^CHANGELOG(\.[a-z]+)?$/i, /^NOTICE(\.[a-z]+)?$/i];

export function readManifest(dir: string): Manifest {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) throw new Error(`${dir} has no ${MANIFEST_FILE}`);
  return parseManifest(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** The files a package carries: the manifest, the build, and the papers that go with the code. */
export function packageFiles(dir: string, manifest: Manifest): string[] {
  const files = listFiles(dir, (rel) => rel === "node_modules" || rel === ".git" || rel === ATTESTATION_FILE).filter(
    (rel) => rel === MANIFEST_FILE || rel === manifest.icon || SHIPPED.some((re) => re.test(rel))
  );
  if (!files.includes(manifest.main)) throw new Error(`${manifest.id}: ${manifest.main} is missing — run the build first`);
  if (files.length > LIMITS.files) throw new Error(`${manifest.id}: ${files.length} files is more than a package may carry (${LIMITS.files})`);
  return files;
}

/**
 * The digest of what a package installs. Taken over the same files whether it
 * is computed at build time, at review, or on the machine that installs it.
 */
export function packageDigest(dir: string, manifest = readManifest(dir)): string {
  return treeDigest(dir, packageFiles(dir, manifest));
}

export async function packPlugin(dir: string, out?: string): Promise<{ file: string; manifest: Manifest; digest: string }> {
  const manifest = readManifest(dir);
  const files = packageFiles(dir, manifest);
  const digest = treeDigest(dir, files);
  const file = out ?? path.join(dir, `${manifest.id.replace("/", "-")}-${manifest.version}${PACKAGE_EXT}`);
  const withAttestation = fs.existsSync(path.join(dir, ATTESTATION_FILE)) ? [...files, ATTESTATION_FILE] : files;
  await tar.c({ gzip: true, file, cwd: dir, portable: true, noMtime: true, noDirRecurse: true }, withAttestation);
  if (fs.statSync(file).size > LIMITS.packageBytes) throw new Error(`${manifest.id}: the package is larger than ${LIMITS.packageBytes} bytes`);
  return { file, manifest, digest };
}

export interface UnpackedPackage {
  dir: string;
  manifest: Manifest;
  digest: string;
  attestation: unknown | null;
}

/** Unpacks into a fresh staging directory. Only regular files and directories, only inside it, only within the limits. */
export async function unpackPlugin(file: string, staging = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-plugin-"))): Promise<UnpackedPackage> {
  if (fs.statSync(file).size > LIMITS.packageBytes) throw new Error(`the package is larger than ${LIMITS.packageBytes} bytes`);
  let bytes = 0;
  let count = 0;
  let refused: string | null = null;
  await tar.x({
    file,
    cwd: staging,
    strict: true,
    preservePaths: false,
    filter: (entryPath, entry) => {
      const type = "type" in entry ? entry.type : "File";
      if (type !== "File" && type !== "Directory" && type !== "OldFile") {
        refused ??= `${entryPath} is a ${type}`;
        return false;
      }
      const size = "size" in entry ? Number(entry.size ?? 0) : 0;
      bytes += size;
      count += 1;
      if (bytes > LIMITS.unpackedBytes || count > LIMITS.files) refused ??= "the package unpacks larger than a plugin may be";
      return !refused;
    }
  });
  if (refused) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new Error(`refused: ${refused}`);
  }
  const manifest = readManifest(staging);
  const attestationFile = path.join(staging, ATTESTATION_FILE);
  const attestation = fs.existsSync(attestationFile) ? (JSON.parse(fs.readFileSync(attestationFile, "utf8")) as unknown) : null;
  return { dir: staging, manifest, digest: packageDigest(staging, manifest), attestation };
}

/** `<root>/<publisher>/<name>/<version>`: versions sit side by side so an update can be taken back. */
export const versionDir = (root: string, manifest: Pick<Manifest, "id" | "version">): string => path.join(root, publisherOf(manifest.id), nameOf(manifest.id), manifest.version);

/** Kept across versions, removed only when a person asks for the data to go too. */
export const dataDirFor = (root: string, id: string): string => path.join(root, publisherOf(id), nameOf(id), "data");

/** Moves an unpacked package into place. The same version already there is replaced. */
export function placePackage(unpacked: UnpackedPackage, root: string): string {
  const target = versionDir(root, unpacked.manifest);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  try {
    fs.renameSync(unpacked.dir, target);
  } catch {
    fs.cpSync(unpacked.dir, target, { recursive: true });
    fs.rmSync(unpacked.dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dataDirFor(root, unpacked.manifest.id), { recursive: true });
  return target;
}

export function writeAttestation(dir: string, attestation: Attestation): void {
  fs.writeFileSync(path.join(dir, ATTESTATION_FILE), `${JSON.stringify(attestation, null, 2)}\n`);
}
