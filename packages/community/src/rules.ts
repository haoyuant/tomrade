import { SDK_CONTRACT, compareVersions, satisfies, type Manifest } from "@tomradex/plugin-sdk";
import type { TrustTier } from "@tomradex/plugin-kit";

/** Every listed version is `community`: the publisher's own, unreviewed build. Tomrade's own are `official`. */
export type Tier = "official" | "community";
export type RiskLevel = "low" | "elevated" | "high";

/** A version as the store lists it. */
export interface VersionRow {
  plugin_id: string;
  version: string;
  commit_sha: string;
  tag: string | null;
  status: "listed" | "revoked" | string;
  tier: Tier;
  risk: RiskLevel | null;
  risk_reasons: string[];
  sdk_range: string | null;
  manifest: Manifest | null;
  digest: string | null;
  attestation: unknown;
  package_path: string | null;
  package_size: number | null;
  listed_at: string | null;
}

export interface Revocation {
  plugin_id: string;
  versions: string;
  reason: string;
}

const RISK_RANK: Record<RiskLevel, number> = { low: 0, elevated: 1, high: 2 };

export const revoked = (id: string, version: string, list: Revocation[]): Revocation | null =>
  list.find((r) => r.plugin_id === id && (r.versions === "*" || satisfies(version, r.versions))) ?? null;

/** The newest version this build can run and nothing has revoked. */
export function latestInstallable(versions: VersionRow[], revocations: Revocation[], sdk = SDK_CONTRACT): VersionRow | null {
  return (
    versions
      .filter((v) => v.status === "listed" && v.package_path && v.digest && (!v.sdk_range || satisfies(sdk, v.sdk_range)) && !revoked(v.plugin_id, v.version, revocations))
      .sort((a, b) => compareVersions(b.version, a.version))[0] ?? null
  );
}

const reach = (m: Manifest | null) => {
  const p = m?.permissions;
  return {
    inject: new Set([...(m?.inject ?? []), ...(m?.optional ?? [])]),
    hosts: new Set(p?.network ?? []),
    fs: p?.fs ?? "none",
    exec: p?.exec ?? false
  };
};

/** What the newer version can reach that the installed one could not. */
export function expansion(installed: Manifest | null, next: Manifest | null): string[] {
  const a = reach(installed);
  const b = reach(next);
  const FS = ["none", "plugin", "project", "any"];
  return [
    ...[...b.inject].filter((s) => !a.inject.has(s)).map((s) => `service:${s}`),
    ...[...b.hosts].filter((h) => !a.hosts.has(h)).map((h) => `host:${h}`),
    ...(FS.indexOf(b.fs) > FS.indexOf(a.fs) ? [`fs:${b.fs}`] : []),
    ...(b.exec && !a.exec ? ["exec"] : [])
  ];
}

export interface UpdatePlan {
  id: string;
  from: string;
  to: VersionRow;
  /** Applied without asking; otherwise it waits in the Updates tab. */
  automatic: boolean;
  /** Why it is not automatic, when it is not. */
  reasons: string[];
  expands: string[];
}

/**
 * Whether an update may land by itself. Nobody reviews a new version, so a
 * plugin only moves by itself when its person switched automatic updates on,
 * the new version reaches no further, and its risk is no higher. One of
 * Tomrade's own only moves to another Tomrade signed.
 */
export function planUpdate(entry: { id: string; version: string; tier: TrustTier; autoUpdate: boolean; manifest: Manifest | null }, versions: VersionRow[], revocations: Revocation[], sdk = SDK_CONTRACT): UpdatePlan | null {
  const next = latestInstallable(versions, revocations, sdk);
  if (!next || compareVersions(next.version, entry.version) <= 0) return null;
  const expands = expansion(entry.manifest, next.manifest);
  const reasons: string[] = [];
  if (!entry.autoUpdate) reasons.push("automatic updates are off");
  if (entry.tier === "local" || entry.tier === "dev") reasons.push("this copy is not the store's");
  if (entry.tier === "official" && next.tier !== "official") reasons.push("Tomrade did not sign the new version");
  if (expands.length) reasons.push("it can reach more than the installed version");
  const installedRisk = versions.find((v) => v.version === entry.version)?.risk ?? "low";
  if (next.risk && RISK_RANK[next.risk] > RISK_RANK[installedRisk]) reasons.push("it is riskier than the installed version");
  return { id: entry.id, from: entry.version, to: next, automatic: reasons.length === 0, reasons, expands };
}
