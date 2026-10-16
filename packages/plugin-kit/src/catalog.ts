import { z } from "zod";
import { AttestationSchema } from "./sign.js";

/**
 * The official catalog: every plugin Tomrade publishes from its plugins
 * repository, and where each signed build lives. Nothing here is trusted for
 * itself — a version counts only when its attestation verifies for its digest.
 */
export const CatalogVersionSchema = z.object({
  version: z.string().min(1),
  sdkRange: z.string().min(1),
  /** The commit of the plugins repository this build was made from. */
  commit: z.string().min(1),
  manifest: z.record(z.string(), z.unknown()),
  risk: z.enum(["low", "elevated", "high"]),
  riskReasons: z.array(z.string()).default([]),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
  /** The package; a relative URL resolves against the catalog's own, so a mirror can serve both. */
  url: z.string().min(1),
  releasedAt: z.string(),
  attestation: AttestationSchema
});
export type CatalogVersion = z.infer<typeof CatalogVersionSchema>;

export const CatalogPluginSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().default(""),
  icon: z.string().optional(),
  repository: z.string().default(""),
  license: z.string(),
  versions: z.array(CatalogVersionSchema)
});
export type CatalogPlugin = z.infer<typeof CatalogPluginSchema>;

export const CatalogRevocationSchema = z.object({ id: z.string(), versions: z.string(), reason: z.string() });
export type CatalogRevocation = z.infer<typeof CatalogRevocationSchema>;

export const CatalogSchema = z.object({
  v: z.literal(1),
  generatedAt: z.string(),
  plugins: z.array(CatalogPluginSchema),
  revoked: z.array(CatalogRevocationSchema).default([])
});
export type Catalog = z.infer<typeof CatalogSchema>;

/**
 * Reads a catalog leniently: one malformed plugin or version is dropped, not
 * the whole catalog. Only a catalog of another format version is refused.
 */
export function parseCatalog(raw: unknown): { catalog: Catalog; dropped: string[] } {
  const outer = z.object({ v: z.literal(1), generatedAt: z.string(), plugins: z.array(z.unknown()), revoked: z.array(z.unknown()).default([]) }).parse(raw);
  const dropped: string[] = [];
  const plugins: CatalogPlugin[] = [];
  for (const p of outer.plugins) {
    const head = CatalogPluginSchema.omit({ versions: true }).extend({ versions: z.array(z.unknown()) }).safeParse(p);
    if (!head.success) {
      dropped.push(String((p as { id?: unknown } | null)?.id ?? "a plugin without an id"));
      continue;
    }
    const versions: CatalogVersion[] = [];
    for (const v of head.data.versions) {
      const parsed = CatalogVersionSchema.safeParse(v);
      if (parsed.success) versions.push(parsed.data);
      else dropped.push(`${head.data.id} ${String((v as { version?: unknown } | null)?.version ?? "?")}`);
    }
    plugins.push({ ...head.data, versions });
  }
  const revoked = outer.revoked.flatMap((r) => {
    const parsed = CatalogRevocationSchema.safeParse(r);
    return parsed.success ? [parsed.data] : [];
  });
  return { catalog: { v: 1, generatedAt: outer.generatedAt, plugins, revoked }, dropped };
}
