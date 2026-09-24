/**
 * Keys whose attestations this build believes: the store's review pipeline
 * signs with the matching private key. `TOMRADE_TRUSTED_KEYS` (a JSON object
 * of keyId → PEM) adds keys for a staging store or local testing.
 */
export const OFFICIAL_KEYS: Record<string, string> = {
  // The store's review key, generated 2026-09-24; the private half lives only with the review worker.
  "124a919478f3571d": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxUxCfh3FEppZJMdusfW56dExchERcKuTZMmfHgeU1oU=
-----END PUBLIC KEY-----
`
};

export function trustedKeys(): Record<string, string> {
  const extra = process.env.TOMRADE_TRUSTED_KEYS;
  if (!extra) return OFFICIAL_KEYS;
  try {
    return { ...OFFICIAL_KEYS, ...(JSON.parse(extra) as Record<string, string>) };
  } catch {
    return OFFICIAL_KEYS;
  }
}
