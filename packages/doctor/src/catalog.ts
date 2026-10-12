import fs from "node:fs";
import { z } from "zod";
import { KnownIssue } from "./issues.js";

/** Read again at most this often: a new entry reaches everyone within hours, no release needed. */
export const CATALOG_MAX_AGE_MS = 6 * 60 * 60_000;

const Catalog = z.object({ version: z.literal(1), issues: z.array(z.unknown()).max(500) });

/**
 * The entries of a catalog that are well formed; a bad one is dropped, never
 * the whole file. Entries are data — what they offer can only name verbs the
 * panel knows — so a catalog can explain and point, but never run anything.
 */
export function parseCatalog(raw: unknown): KnownIssue[] {
  const parsed = Catalog.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.issues.flatMap((entry) => {
    const issue = KnownIssue.safeParse(entry);
    return issue.success ? [issue.data] : [];
  });
}

export interface CachedCatalog {
  fetchedAt: number;
  issues: KnownIssue[];
}

export function readCache(file: string): CachedCatalog | null {
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt?: number; catalog?: unknown };
    return typeof cached.fetchedAt === "number" ? { fetchedAt: cached.fetchedAt, issues: parseCatalog(cached.catalog) } : null;
  } catch {
    return null;
  }
}

/** The catalog from tomrade.com; null when it could not be read, so the cache stays. */
export async function fetchCatalog(url: string, fetcher: typeof fetch = fetch): Promise<{ raw: unknown; issues: KnownIssue[] } | null> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown;
    return { raw, issues: parseCatalog(raw) };
  } catch {
    return null;
  }
}
