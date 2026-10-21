import { describe, expect, it } from "vitest";
import { byNamespace, checkLocales, recordHashes, sourceHash } from "../../../scripts/i18n-check.mjs";

const en = { common: { save: "Save", cancel: "Cancel", close: "Close" }, about: { title: "About Tomrade" } };

describe("pnpm i18n:check", () => {
  it("counts a translation current once its English is recorded, and stale when the English changes", () => {
    const de = { common: { save: "Speichern", cancel: "Abbrechen" } };
    const hashes = { de: recordHashes(en, de) };
    expect(checkLocales(en, { de }, hashes).de).toEqual({ missing: ["common.close", "about.title"], stale: [], unrecorded: [] });

    const changed = { ...en, common: { ...en.common, save: "Save all" } };
    expect(checkLocales(changed, { de }, hashes).de.stale).toEqual(["common.save"]);
  });

  it("reports a translation with no English on record, and drops records for keys no longer translated", () => {
    const fr = { common: { save: "Enregistrer" }, about: { title: "À propos de Tomrade" } };
    const hashes = { fr: { common: { save: sourceHash("Save"), cancel: sourceHash("Cancel") } } };
    expect(checkLocales(en, { fr }, hashes).fr.unrecorded).toEqual(["about.title"]);
    expect(recordHashes(en, fr)).toEqual({ about: { title: sourceHash("About Tomrade") }, common: { save: sourceHash("Save") } });
  });

  it("groups keys by namespace, most first", () => {
    expect(byNamespace(["a.x", "b.x", "b.y", "c.z"])).toBe("b 2, a 1, c 1");
  });
});
