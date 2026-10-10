export { analyzePackage, atLeast, mismatches, observedRisk, type Analysis, type Finding, type Observed, type Severity } from "./analyze.js";
export { listFiles, sha256, treeDigest } from "./digest.js";
export { LOCK_FILE, LockEntrySchema, LockSchema, readLock, tierOf, writeLock, type Lock, type LockEntry, type TrustTier } from "./lock.js";
export {
  ATTESTATION_FILE,
  LIMITS,
  PACKAGE_EXT,
  dataDirFor,
  packPlugin,
  packageDigest,
  packageFiles,
  placePackage,
  readManifest,
  unpackPlugin,
  versionDir,
  writeAttestation,
  type UnpackedPackage
} from "./package.js";
export { AttestationSchema, attest, generateSigningKey, keyIdOf, verifyAttestation, type Attestation, type AttestationClaims } from "./sign.js";
