/**
 * Keys whose attestations this build believes: the store's review pipeline
 * signs with the matching private key. `TOMRADE_TRUSTED_KEYS` (a JSON object
 * of keyId → PEM) adds keys for a staging store or local testing.
 */
export const OFFICIAL_KEYS: Record<string, string> = {};

export function trustedKeys(): Record<string, string> {
  const extra = process.env.TOMRADE_TRUSTED_KEYS;
  if (!extra) return OFFICIAL_KEYS;
  try {
    return { ...OFFICIAL_KEYS, ...(JSON.parse(extra) as Record<string, string>) };
  } catch {
    return OFFICIAL_KEYS;
  }
}
