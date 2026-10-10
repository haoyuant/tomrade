import crypto from "node:crypto";
import { z } from "zod";

/** Tomrade vouching for one exact build of one version of a plugin it published itself. */
export const AttestationSchema = z.object({
  v: z.literal(1),
  id: z.string(),
  version: z.string(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  tier: z.literal("official"),
  risk: z.enum(["low", "elevated", "high"]),
  issuedAt: z.number(),
  keyId: z.string(),
  signature: z.string()
});
export type Attestation = z.infer<typeof AttestationSchema>;
export type AttestationClaims = Omit<Attestation, "keyId" | "signature">;

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

export const keyIdOf = (publicKeyPem: string): string =>
  crypto.createHash("sha256").update(crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);

export function generateSigningKey(): { keyId: string; publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { keyId: keyIdOf(pub), publicKey: pub, privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
}

export function attest(claims: AttestationClaims, privateKeyPem: string): Attestation {
  const key = crypto.createPrivateKey(privateKeyPem);
  const keyId = keyIdOf(crypto.createPublicKey(key).export({ type: "spki", format: "pem" }).toString());
  const signature = crypto.sign(null, Buffer.from(canonical({ ...claims, keyId })), key).toString("base64");
  return { ...claims, keyId, signature };
}

/** Valid only for the digest it names, and only under a key this build trusts. */
export function verifyAttestation(raw: unknown, digest: string, trusted: Record<string, string>): Attestation | null {
  const parsed = AttestationSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { signature, ...rest } = parsed.data;
  const pem = trusted[rest.keyId];
  if (!pem || rest.digest !== digest) return null;
  try {
    return crypto.verify(null, Buffer.from(canonical(rest)), crypto.createPublicKey(pem), Buffer.from(signature, "base64")) ? parsed.data : null;
  } catch {
    return null;
  }
}
