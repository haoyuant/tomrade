import { SDK_CONTRACT } from "./manifest.js";
import { compareVersions, parseVersion, satisfies } from "./semver.js";

/**
 * The contract each value the SDK exports first shipped in. A plugin imports
 * the SDK from the Tomrade it runs in, not from its own bundle, so a name the
 * oldest Tomrade its `engines.sdk` accepts does not have fails the plugin as it
 * loads. A new export is listed here under the contract it ships in.
 */
export const SDK_EXPORTS: Readonly<Record<string, string>> = {
  ContributesSchema: "0.2.0",
  MANIFEST_FILE: "0.2.0",
  ManifestSchema: "0.2.0",
  NAMESPACE: "0.2.0",
  OFFICIAL_PUBLISHER: "0.2.0",
  OSI_LICENSES: "0.2.0",
  PLUGIN_ID: "0.2.0",
  PermissionsSchema: "0.2.0",
  RESERVED_NAMESPACES: "0.2.0",
  SDK_CONTRACT: "0.2.0",
  SDK_PLUGIN: "0.2.0",
  ToolInputError: "0.2.0",
  assertOwned: "0.2.0",
  compareVersions: "0.2.0",
  definePlugin: "0.2.0",
  defineTool: "0.2.0",
  isOpenSource: "0.2.0",
  isSdkPlugin: "0.2.0",
  isVersion: "0.2.0",
  nameOf: "0.2.0",
  namespaceOf: "0.2.0",
  ownsId: "0.2.0",
  parseManifest: "0.2.0",
  parseVersion: "0.2.0",
  publisherOf: "0.2.0",
  requireProjectId: "0.2.0",
  riskOf: "0.2.0",
  satisfies: "0.2.0",
  ImDeliveryError: "0.2.1",
  IM_CAPABILITIES_V2: "0.2.5",
  IM_MARKDOWN_DIALECTS: "0.2.5",
  ImCapabilitiesSchema: "0.2.5",
  resolveImCapabilities: "0.2.5",
  splitImText: "0.2.5",
  toImDialect: "0.2.5",
  isRange: "0.2.7",
  LANGUAGE_PACK_LIMITS: "0.2.8",
  LanguageEntrySchema: "0.2.8",
  LanguagePackFileSchema: "0.2.8",
  languageCoverage: "0.2.8",
  parseLanguagePack: "0.2.8",
  slotsOf: "0.2.8",
  SDK_EXPORTS: "0.2.9",
  lowestContract: "0.2.9",
  pickLanguage: "0.2.9",
  wordsFor: "0.2.9",
  RowSchema: "0.2.13"
};

/** The oldest contract `range` accepts, up to this SDK's own; null when it accepts none of them. */
export function lowestContract(range: string): string | null {
  const known = [...Object.values(SDK_EXPORTS), SDK_CONTRACT];
  // Every patch of each minor the SDK has shipped, since a contract that added no export is still one a Tomrade may run.
  const lines = new Map<string, number>();
  for (const v of known) {
    const p = parseVersion(v);
    if (p) lines.set(`${p[0]}.${p[1]}`, Math.max(lines.get(`${p[0]}.${p[1]}`) ?? 0, p[2]));
  }
  const candidates = [...lines].flatMap(([line, last]) => Array.from({ length: last + 1 }, (_, patch) => `${line}.${patch}`)).sort(compareVersions);
  return candidates.find((v) => compareVersions(v, SDK_CONTRACT) <= 0 && satisfies(v, range)) ?? null;
}
