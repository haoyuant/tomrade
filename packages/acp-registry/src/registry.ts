import fs from "node:fs";
import { z } from "zod";

/** One file on a CDN carries every agent's manifest; the registry is curated and only lists agents that support authentication. */
export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** Read again at most this often; until then the cache answers, offline included. */
export const REGISTRY_MAX_AGE_MS = 24 * 60 * 60_000;

const Npx = z.object({
  package: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({})
});

export const RegistryAgent = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  version: z.string().default(""),
  description: z.string().default(""),
  license: z.string().optional(),
  repository: z.string().optional(),
  distribution: z.object({ npx: Npx.optional() })
});
export type RegistryAgent = z.infer<typeof RegistryAgent>;

/**
 * The entries Tomrade can offer: well formed and with an `npx` distribution —
 * `binary` has no signing convention yet and `uvx` needs Python, so neither is
 * run. A bad entry is dropped, never the whole file. Entries are data: nothing
 * in them runs at parse time.
 */
export function parseRegistry(raw: unknown): RegistryAgent[] {
  const listed = z.object({ agents: z.array(z.unknown()) }).safeParse(raw);
  if (!listed.success) return [];
  return listed.data.agents.flatMap((entry) => {
    const agent = RegistryAgent.safeParse(entry);
    return agent.success && agent.data.distribution.npx ? [agent.data] : [];
  });
}

export interface CachedRegistry {
  fetchedAt: number;
  agents: RegistryAgent[];
}

export function readCache(file: string): CachedRegistry | null {
  try {
    const cached = JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt?: number; registry?: unknown };
    return typeof cached.fetchedAt === "number" ? { fetchedAt: cached.fetchedAt, agents: parseRegistry(cached.registry) } : null;
  } catch {
    return null;
  }
}

export function writeCache(file: string, fetchedAt: number, registry: unknown): void {
  try {
    fs.writeFileSync(file, `${JSON.stringify({ fetchedAt, registry })}\n`);
  } catch {
    // Only the next launch starts without it.
  }
}

/** The registry from its CDN; null when it could not be read, so the cache stays. */
export async function fetchRegistry(url: string, fetcher: typeof fetch = fetch): Promise<{ raw: unknown; agents: RegistryAgent[] } | null> {
  try {
    const res = await fetcher(url, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown;
    return { raw, agents: parseRegistry(raw) };
  } catch {
    return null;
  }
}
