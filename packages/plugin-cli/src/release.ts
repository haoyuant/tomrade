import fs from "node:fs";
import path from "node:path";
import { ATTESTATION_FILE, CatalogRevocationSchema, PACKAGE_EXT, analyzePackage, attest, observedRisk, packPlugin, packageDigest, parseCatalog, type Catalog, type CatalogVersion } from "@tomradex/plugin-kit";
import { MANIFEST_FILE, nameOf, publisherOf } from "@tomradex/plugin-sdk";
import { check, type CheckReport } from "./check.js";
import type { SandboxOptions } from "./sandbox.js";

export interface ReleaseOptions extends SandboxOptions {
  /** Tomrade's signing key, PKCS#8 PEM. */
  privateKey: string;
  /** Where the package and the new catalog are written. */
  out: string;
  /** The catalog released so far; none starts a new one. */
  catalog?: string;
  /** The commit of the plugins repository the build comes from. */
  commit: string;
  /** Replaces the catalog's revocations: `[{ id, versions, reason }]`. */
  revoked?: string;
}

export interface Released {
  report: CheckReport;
  /** Null when the check blocked it. */
  file: string | null;
  digest: string | null;
  catalog: string | null;
  /** The version was in the catalog already, as this same build. */
  unchanged: boolean;
}

const emptyCatalog = (): Catalog => ({ v: 1, generatedAt: new Date().toISOString(), plugins: [], revoked: [] });

/**
 * One version of one of Tomrade's own plugins, released: checked against the
 * official standard, signed for its exact digest, packed, and added to the
 * catalog Tomrade reads. A version already released stays as it was; a
 * different build under the same version is refused.
 */
export async function release(dir: string, opts: ReleaseOptions): Promise<Released> {
  const report = await check(dir, { ...opts, official: true });
  if (report.verdict === "blocked" || !report.manifest) return { report, file: null, digest: null, catalog: null, unchanged: false };
  const m = report.manifest;
  const catalog = opts.catalog && fs.existsSync(opts.catalog) ? parseCatalog(JSON.parse(fs.readFileSync(opts.catalog, "utf8"))).catalog : emptyCatalog();
  const digest = packageDigest(dir, m);
  const fileName = `${publisherOf(m.id)}-${nameOf(m.id)}-${m.version}${PACKAGE_EXT}`;
  fs.mkdirSync(opts.out, { recursive: true });
  const catalogFile = path.join(opts.out, "catalog.json");
  const entry = catalog.plugins.find((p) => p.id === m.id);
  const released = entry?.versions.find((v) => v.version === m.version);
  if (released && released.digest !== digest) throw new Error(`${m.id} ${m.version} was released already as another build; raise the version`);

  let file: string | null = null;
  if (!released) {
    const risk = observedRisk((report.analysis ?? analyzePackage(dir, m)).observed, m);
    const attestation = attest({ v: 1, id: m.id, version: m.version, digest, tier: "official", risk: risk.level, issuedAt: Date.now() }, opts.privateKey);
    fs.writeFileSync(path.join(dir, ATTESTATION_FILE), JSON.stringify(attestation));
    try {
      const packed = await packPlugin(dir, path.join(opts.out, fileName));
      if (packed.digest !== digest) throw new Error(`${m.id} changed while it was packed`);
      file = packed.file;
    } finally {
      fs.rmSync(path.join(dir, ATTESTATION_FILE), { force: true });
    }
    const version: CatalogVersion = {
      version: m.version,
      sdkRange: m.engines.sdk,
      commit: opts.commit,
      manifest: JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Record<string, unknown>,
      risk: risk.level,
      riskReasons: risk.reasons,
      digest,
      size: fs.statSync(file).size,
      url: fileName,
      releasedAt: new Date().toISOString(),
      attestation
    };
    const plugin = { id: m.id, title: m.title, description: m.description, repository: m.repository ?? "", license: m.license, versions: [...(entry?.versions ?? []), version] };
    catalog.plugins = [...catalog.plugins.filter((p) => p.id !== m.id), plugin].sort((a, b) => a.id.localeCompare(b.id));
  }
  if (opts.revoked) catalog.revoked = CatalogRevocationSchema.array().parse(JSON.parse(fs.readFileSync(opts.revoked, "utf8")));
  catalog.generatedAt = new Date().toISOString();
  // Parsed once more, so a catalog this writes is one Tomrade reads.
  fs.writeFileSync(catalogFile, `${JSON.stringify(parseCatalog(JSON.parse(JSON.stringify(catalog))).catalog, null, 2)}\n`);
  return { report, file, digest, catalog: catalogFile, unchanged: !!released };
}
