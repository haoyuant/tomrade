import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "@tomradex/plugin-sdk";
import { packageFiles, readLanguagePack, readManifest, unpackPlugin } from "@tomradex/plugin-kit";
import { check, pack } from "@tomradex/plugin-cli";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-language-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const english = {
  ui: { common: { cancel: "Cancel", save: "Save", closeTitled: "Close {{title}}" } },
  backend: { doctor: { stopped: "Stopped.", waiting: "{{n}} waiting" } }
};

function languagePack(name: string, words: unknown) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "languages"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, MANIFEST_FILE),
    JSON.stringify({ id: `someone/${name}`, version: "1.0.0", title: "Português", description: "Brazilian Portuguese for Tomrade.", license: "MIT", engines: { sdk: "^0.2.8" }, main: null, languages: [{ tag: "pt-BR", name: "Português (Brasil)", file: "languages/pt-BR.json" }] })
  );
  fs.writeFileSync(path.join(dir, "languages/pt-BR.json"), typeof words === "string" ? words : JSON.stringify(words));
  fs.writeFileSync(path.join(dir, "README.md"), "# Português\n");
  return dir;
}

describe("a language pack, checked", () => {
  it("needs no build, and says how much of English it covers", async () => {
    const dir = languagePack("portugues", {
      ui: { common: { cancel: "Cancelar", closeTitled: "Fechar {{titulo}}", retired: "Antigo" } },
      backend: { doctor: { stopped: "Parado.", waiting: "{{n}} aguardando" } }
    });
    const report = await check(dir, { english });
    expect(report.problems).toEqual([]);
    expect(report.build).toBeNull();
    expect(report.inspection).toBeNull();
    expect(report.verdict).toBe("ok");
    expect(report.risk?.level).toBe("low");
    const [pt] = report.languages;
    expect(pt).toMatchObject({ tag: "pt-BR", name: "Português (Brasil)" });
    expect(pt!.ui).toMatchObject({ total: 3, translated: 1, missing: ["common.save"], stale: ["common.retired"], slotMismatches: [{ key: "common.closeTitled", english: ["{{title}}"], translated: ["{{titulo}}"] }] });
    expect(pt!.backend).toMatchObject({ total: 2, translated: 2, missing: [], stale: [], slotMismatches: [] });
    expect(report.notes).toEqual(
      expect.arrayContaining([
        'language "pt-BR": 1 of 3 interface strings translated; the rest read English',
        'language "pt-BR": interface strings it does not translate: common.save',
        'language "pt-BR": interface keys English no longer has, which nothing reads: common.retired',
        expect.stringMatching(/common\.closeTitled asks for \{\{titulo\}\} where English asks for \{\{title\}\}/),
        'language "pt-BR": 2 of 2 backend strings translated; the rest read English'
      ])
    );
  });

  it("says where coverage is measured when it has no English to measure against", async () => {
    const report = await check(languagePack("sem-ingles", { ui: { common: { cancel: "Cancelar" } } }));
    expect(report.verdict).toBe("ok");
    expect(report.languages).toEqual([{ tag: "pt-BR", name: "Português (Brasil)", ui: null, backend: null }]);
    expect(report.notes).toEqual(expect.arrayContaining([expect.stringMatching(/interface coverage is measured against a running Tomrade's English/)]));
  });

  it("blocks a pack file that is not the format", async () => {
    const report = await check(languagePack("quebrado", { ui: { common: { cancel: ["Cancelar"] } } }));
    expect(report.verdict).toBe("blocked");
    expect(report.problems).toEqual([expect.stringMatching(/^language "pt-BR": languages\/pt-BR\.json ui\.common\.cancel/)]);
    expect((await check(languagePack("nao-json", "{"), { english })).problems).toEqual([expect.stringMatching(/is not JSON/)]);
  });

  it("packs the manifest and its words, and nothing that runs", async () => {
    const dir = languagePack("empacotado", { ui: { common: { cancel: "Cancelar" } } });
    fs.mkdirSync(path.join(dir, "src"));
    fs.writeFileSync(path.join(dir, "src/notes.ts"), "// not shipped");
    expect(packageFiles(dir, readManifest(dir))).toEqual(["README.md", "languages/pt-BR.json", MANIFEST_FILE]);
    const { file } = await pack(dir, { out: path.join(tmp, "empacotado.tomrade-plugin") });
    const unpacked = await unpackPlugin(file!);
    expect(readLanguagePack(unpacked.dir, unpacked.manifest.languages[0]!).ui).toEqual({ common: { cancel: "Cancelar" } });
    expect(fs.existsSync(path.join(unpacked.dir, "src"))).toBe(false);
    fs.rmSync(path.join(dir, "languages/pt-BR.json"));
    expect(() => packageFiles(dir, readManifest(dir))).toThrow(/language file languages\/pt-BR\.json is missing/);
  });
});
