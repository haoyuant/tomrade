/**
 * Which settings values are secrets: strings under a secret-sounding key, and
 * every value in an `env`, `headers` or `credentials` map. One rule decides both what an
 * agent never reads and what settings.json keeps encrypted, so the two can't
 * drift apart — and it needs no schema, so a section whose plugin is switched
 * off is still covered.
 */
const SECRET_KEY = /api.?key|secret|token|passw|credential|authori[sz]ation|cookie|private.?key/i;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const join = (path: string, key: string | number) => (typeof key === "number" ? `${path}[${key}]` : path ? `${path}.${key}` : key);

/** `value` with `fn` applied to each secret string; `path` names where it sits, e.g. `models.profiles[0].apiKey`. */
export function mapSecrets(value: unknown, fn: (secret: string, path: string) => unknown, key = "", path = ""): unknown {
  if (Array.isArray(value)) return value.map((v, i) => mapSecrets(v, fn, key, join(path, i)));
  if (isRecord(value)) {
    const whole = key === "env" || key === "headers" || key === "credentials";
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, whole && typeof v === "string" ? fn(v, join(path, k)) : mapSecrets(v, fn, k, join(path, k))])
    );
  }
  return typeof value === "string" && SECRET_KEY.test(key) ? fn(value, path) : value;
}

/** `value` with `fn` applied to every string in it, secret or not. */
export function mapStrings(value: unknown, fn: (text: string, path: string) => unknown, path = ""): unknown {
  if (Array.isArray(value)) return value.map((v, i) => mapStrings(v, fn, join(path, i)));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn, join(path, k))]));
  return typeof value === "string" ? fn(value, path) : value;
}

/** The OS keychain's encryption, supplied by the desktop shell (Electron's safeStorage). */
export interface SecretCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

/** How an encrypted value starts in settings.json. */
export const SEALED = "tomrade-encrypted:v1:";
