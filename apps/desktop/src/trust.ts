/**
 * Keys whose attestations this build believes: Tomrade signs its own plugins
 * as official with the matching private key (`tomrade-store official`). `TOMRADE_TRUSTED_KEYS` (a JSON object
 * of keyId → PEM) adds keys for a staging store or local testing.
 */
export const OFFICIAL_KEYS: Record<string, string> = {
  // The store key, generated 2026-09-24; the private half stays off shared machines.
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
