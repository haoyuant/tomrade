import type { AbRow } from "./analytics-data.js";

// The arithmetic of the site's A/B test, as tomrade-site's scripts/ab-stats.mjs does it for `pnpm ab`:
// the two must agree, so a change to one belongs in the other.

/** One version's totals: page loads counted for everyone, then people, for visitors who said yes. */
export interface AbCounts { views: number; downloads: number; downloadPages: number; downloadsViaPage: number; visitors: number; engaged: number; downloaders: number }
export interface AbGroup { a: AbCounts; b: AbCounts }
export const AB_SCOPES = ["desktop", "mobile", "all"] as const;
export type AbScope = typeof AB_SCOPES[number];

const EVENTS: Record<string, keyof AbCounts> = {
  view: "views", download: "downloads", "download-page": "downloadPages", "download-via-page": "downloadsViaPage",
  visitor: "visitors", engaged: "engaged", downloader: "downloaders"
};
const empty = (): AbCounts => ({ views: 0, downloads: 0, downloadPages: 0, downloadsViaPage: 0, visitors: 0, engaged: 0, downloaders: 0 });

/** One test's rows added up per version, for each kind of device and for all of them. */
export function abGroups(rows: AbRow[], test: string): Record<AbScope, AbGroup> {
  const groups: Record<AbScope, AbGroup> = { desktop: { a: empty(), b: empty() }, mobile: { a: empty(), b: empty() }, all: { a: empty(), b: empty() } };
  for (const row of rows) {
    const field = EVENTS[row.event];
    if (row.test !== test || !field || (row.variant !== "a" && row.variant !== "b")) continue;
    groups.all[row.variant][field] += Number(row.n);
    if (row.device === "desktop" || row.device === "mobile") groups[row.device][row.variant][field] += Number(row.n);
  }
  return groups;
}

/** Installer links followed from the home page or, by the same visitors, from the download page. */
export const abDownloads = (c: AbCounts) => c.downloads + c.downloadsViaPage;

/** The standard normal distribution's cumulative function (Abramowitz and Stegun 26.2.17, good to 7 places). */
function phi(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const tail = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI) * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/** k out of n as a rate, with the Wilson 95% interval, which stays sensible when k is small. Null when n is 0. */
export function abRate(k: number, n: number): { rate: number; low: number; high: number } | null {
  if (n <= 0) return null;
  const z = 1.96;
  const p = k / n;
  const middle = (p + (z * z) / (2 * n)) / (1 + (z * z) / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / (1 + (z * z) / n);
  return { rate: p, low: Math.max(0, middle - half), high: Math.min(1, middle + half) };
}

export interface AbGap {
  /** B's rate over A's, less one; null when A's rate is 0. */
  lift: number | null;
  /** The chance of a gap this wide if the two were really the same (two-sided, pooled two-proportion z test). */
  p: number;
  /** False while either side has too little to tell. */
  enough: boolean;
}
export function abCompare(a: { k: number; n: number }, b: { k: number; n: number }): AbGap {
  const [pa, pb] = [a.n ? a.k / a.n : 0, b.n ? b.k / b.n : 0];
  const enough = a.n >= 30 && b.n >= 30 && a.k + b.k >= 10;
  const pooled = (a.k + b.k) / (a.n + b.n || 1);
  const spread = Math.sqrt(pooled * (1 - pooled) * (1 / (a.n || 1) + 1 / (b.n || 1)));
  const z = spread ? (pb - pa) / spread : 0;
  return { lift: pa ? pb / pa - 1 : null, p: 2 * (1 - phi(Math.abs(z))), enough };
}
