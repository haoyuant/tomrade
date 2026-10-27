import { expect, it } from "vitest";
import { CLI_HOOK_COVERAGE, ManifestSchema, parseManifest, riskOf } from "@tomradex/plugin-sdk";

const manifest = (permissions: Record<string, unknown> = {}) => ManifestSchema.parse({ id: "someone/demo", version: "1.0.0", title: "Demo", license: "MIT", engines: { sdk: "^0.2.11" }, permissions });

it("grants no windows unless the manifest says so, and shows a window as a reason to look closer", () => {
  expect(manifest().permissions.window).toBe(false);
  expect(riskOf(manifest())).toEqual({ level: "low", reasons: [] });
  const windowed = manifest({ window: true, why: { window: "Shows the terminals of code sessions side by side." } });
  expect(windowed.permissions.window).toBe(true);
  expect(riskOf(windowed)).toEqual({ level: "elevated", reasons: ["window"] });
  expect(riskOf(manifest({ window: true, exec: true }))).toEqual({ level: "high", reasons: ["exec", "window"] });
});

const full = (fields: Record<string, unknown>) => ({ id: "someone/deep", version: "1.0.0", title: "Deep", license: "MIT", engines: { sdk: "^0.2.13", tomrade: ">=0.13.0 <0.14.0" }, context: "full", ...fields });

it("takes a full-mode plugin that names its Tomrade versions, labels it high risk, and holds rows to full mode", () => {
  const plain = parseManifest(full({}));
  expect(plain.context).toBe("full");
  expect(riskOf(plain)).toEqual({ level: "high", reasons: ["full"] });
  const rowed = parseManifest(full({ rows: [{ id: "llm", name: "./dist/llm.js" }, { id: "web-search-tavily", disabled: true }] }));
  expect(riskOf(rowed)).toEqual({ level: "high", reasons: ["full", "rows"] });
  expect(parseManifest({ ...full({}), context: undefined }).context).toBe("sdk");

  expect(() => parseManifest(full({ engines: { sdk: "^0.2.13" } }))).toThrow(/engines.tomrade/);
  expect(() => parseManifest(full({ main: null, languages: [{ tag: "pt-BR", name: "Português", file: "languages/pt-BR.json" }] }))).toThrow(/needs "main"/);
  expect(() => parseManifest(full({ context: "sdk", rows: [{ id: "llm", disabled: true }] }))).toThrow(/takes "context": "full"/);
  expect(() => parseManifest(full({ rows: [{ id: "llm", disabled: true }, { id: "llm", config: {} }] }))).toThrow(/listed twice/);
  expect(() => ManifestSchema.parse(full({ rows: [{ id: "llm" }] }))).toThrow(/changes something/);
});

it("says which agents a CLI hook reaches: every agent that reports hooks, the ones that act on an answer among them", () => {
  expect(CLI_HOOK_COVERAGE["pre-tool"]).toEqual({ answers: ["claude-code", "workbuddy", "dsh", "pi", "codex", "opencode", "cursor"], sees: ["hermes", "gemini"] });
  expect(CLI_HOOK_COVERAGE.stop.answers).not.toContain("pi");
  expect(CLI_HOOK_COVERAGE["session-end"].answers).toEqual([]);
  for (const reach of Object.values(CLI_HOOK_COVERAGE)) expect([...reach.answers, ...reach.sees].sort()).toEqual(["claude-code", "codex", "cursor", "dsh", "gemini", "hermes", "opencode", "pi", "workbuddy"]);
});

it("takes a plugin that adds model providers through the models service", () => {
  const m = ManifestSchema.parse({ id: "someone/acme", version: "1.0.0", title: "Acme", license: "MIT", engines: { sdk: "^0.2.16" }, inject: ["models"], contributes: { modelProviders: ["acme"] } });
  expect(m.inject).toEqual(["models"]);
  expect(m.contributes.modelProviders).toEqual(["acme"]);
});

it("labels a model provider plugin elevated: it reads the conversations and keys of the profiles on it", () => {
  const provider = ManifestSchema.parse({ id: "someone/acme", version: "1.0.0", title: "Acme", license: "MIT", engines: { sdk: "^0.2.16" }, inject: ["models"] });
  expect(riskOf(provider)).toEqual({ level: "elevated", reasons: ["models"] });
  expect(riskOf({ ...provider, inject: [], optional: ["models"] }).reasons).toEqual(["models"]);
});
