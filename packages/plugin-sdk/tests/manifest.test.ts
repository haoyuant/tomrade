import { expect, it } from "vitest";
import { ManifestSchema, riskOf } from "@tomradex/plugin-sdk";

const manifest = (permissions: Record<string, unknown> = {}) => ManifestSchema.parse({ id: "someone/demo", version: "1.0.0", title: "Demo", license: "MIT", engines: { sdk: "^0.2.11" }, permissions });

it("grants no windows unless the manifest says so, and shows a window as a reason to look closer", () => {
  expect(manifest().permissions.window).toBe(false);
  expect(riskOf(manifest())).toEqual({ level: "low", reasons: [] });
  const windowed = manifest({ window: true, why: { window: "Shows the terminals of code sessions side by side." } });
  expect(windowed.permissions.window).toBe(true);
  expect(riskOf(windowed)).toEqual({ level: "elevated", reasons: ["window"] });
  expect(riskOf(manifest({ window: true, exec: true }))).toEqual({ level: "high", reasons: ["exec", "window"] });
});
