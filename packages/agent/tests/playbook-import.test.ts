import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { Tools } from "@tomradex/tools";
import { Settings } from "@tomradex/settings";
import { FakeChatModel, fakeChat } from "@tomradex/llm";
import { Agent, installPlaybook, keptVersions, loadPlaybookDir, parseSource, readOrigin, readSkills, uninstallLatest, validateSkill } from "@tomradex/agent";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-pb-import-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let n = 0;
const tmp = (name: string) => {
  const dir = path.join(root, `${name}-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const skill = (name: string, body = "1. Do it.", extra = "") => `---\nname: ${name}\ndescription: when ${name} is asked for${extra}\n---\n\n${body}\n`;

function writeSkill(dir: string, name: string, body?: string, files: Record<string, string> = {}): string {
  const folder = path.join(dir, name);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "SKILL.md"), skill(name, body));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, rel)), { recursive: true });
    fs.writeFileSync(path.join(folder, rel), text);
  }
  return folder;
}

/** A fake GitHub: the API's repo and tree answers, and raw files. */
function fakeGithub(files: Record<string, string>, defaultBranch = "main") {
  const calls: string[] = [];
  const respond = (status: number, body: unknown) => ({
    ok: status < 400,
    status,
    json: async () => body,
    arrayBuffer: async () => {
      const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }
  });
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url === "https://api.github.com/repos/acme/skills") return respond(200, { default_branch: defaultBranch });
    if (url.startsWith("https://api.github.com/repos/acme/skills/git/trees/")) {
      return respond(200, { tree: Object.entries(files).map(([p, text]) => ({ path: p, type: "blob", size: text.length })) });
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/acme\/skills\/[^/]+\/(.+)$/.exec(url);
    if (raw && files[decodeURIComponent(raw[1])] !== undefined) return respond(200, files[decodeURIComponent(raw[1])]);
    return respond(404, "not found");
  };
  return { fetchImpl, calls };
}

describe("parseSource", () => {
  it("reads GitHub, raw, skills.sh, a plain URL and a folder", () => {
    expect(parseSource("https://github.com/acme/skills")).toEqual({ kind: "github", place: { owner: "acme", repo: "skills", dir: "" } });
    expect(parseSource("https://github.com/acme/skills/tree/dev/skills/pdf")).toEqual({ kind: "github", place: { owner: "acme", repo: "skills", ref: "dev", dir: "skills/pdf" } });
    expect(parseSource("https://github.com/acme/skills/blob/main/pdf/SKILL.md")).toEqual({ kind: "github", place: { owner: "acme", repo: "skills", ref: "main", dir: "pdf" } });
    expect(parseSource("https://raw.githubusercontent.com/acme/skills/main/pdf/SKILL.md")).toEqual({ kind: "github", place: { owner: "acme", repo: "skills", ref: "main", dir: "pdf" } });
    expect(parseSource("https://skills.sh/acme/skills/pdf")).toEqual({ kind: "github", place: { owner: "acme", repo: "skills", dir: "", skill: "pdf" } });
    expect(parseSource("https://example.com/x/SKILL.md")).toEqual({ kind: "url", url: "https://example.com/x/SKILL.md" });
    expect(parseSource("/tmp/a/.claude/skills/review/SKILL.md")).toEqual({ kind: "local", dir: path.resolve("/tmp/a/.claude/skills/review") });
  });
});

describe("readSkills", () => {
  it("takes one folder with its supporting files, or every skill folder under a parent", async () => {
    const dir = tmp("local");
    const one = writeSkill(dir, "review", "Look.", { "references/style.md": "be kind", "scripts/run.sh": "echo hi" });
    writeSkill(dir, "ship");
    fs.mkdirSync(path.join(one, "node_modules"));
    fs.writeFileSync(path.join(one, "node_modules", "x.js"), "");
    const single = await readSkills(one);
    expect(single).toHaveLength(1);
    expect([...single[0].files.keys()].sort()).toEqual(["SKILL.md", "references/style.md", "scripts/run.sh"]);
    expect((await readSkills(dir)).map((s) => s.name).sort()).toEqual(["review", "ship"]);
  });

  it("reads a repository's skills, a folder in it, and a skills.sh page by name", async () => {
    const gh = fakeGithub({
      "README.md": "hi",
      "skills/pdf/SKILL.md": skill("pdf"),
      "skills/pdf/references/forms.md": "forms",
      "skills/docx/SKILL.md": skill("docx")
    });
    expect((await readSkills("https://github.com/acme/skills", gh.fetchImpl)).map((s) => s.name).sort()).toEqual(["docx", "pdf"]);
    const pdf = await readSkills("https://skills.sh/acme/skills/pdf", gh.fetchImpl);
    expect(pdf.map((s) => s.name)).toEqual(["pdf"]);
    expect([...pdf[0].files.keys()].sort()).toEqual(["SKILL.md", "references/forms.md"]);
    const tree = await readSkills("https://github.com/acme/skills/tree/main/skills/docx", gh.fetchImpl);
    expect(tree.map((s) => s.name)).toEqual(["docx"]);
  });

  it("says plainly when there is nothing to import", async () => {
    const gh = fakeGithub({ "README.md": "hi" });
    await expect(readSkills("https://github.com/acme/skills", gh.fetchImpl)).rejects.toMatchObject({ code: "noSkill" });
    await expect(readSkills("https://github.com/acme/missing", gh.fetchImpl)).rejects.toMatchObject({ code: "notFound" });
    await expect(readSkills(tmp("empty"))).rejects.toMatchObject({ code: "noSkill" });
  });
});

describe("validateSkill", () => {
  const of = (text: string, name = "x") => ({ name, files: new Map([["SKILL.md", Buffer.from(text)]]) });
  it("refuses a SKILL.md without a description, with broken frontmatter, or an unsafe id", () => {
    expect(() => validateSkill(of("---\nname: x\n---\n\nbody"))).toThrow(/no description/);
    expect(() => validateSkill(of("---\nname: [x\n---\n\nbody"))).toThrow(/SKILL\.md/);
    expect(() => validateSkill(of("---\nname: ../evil\ndescription: d\n---\n\nbody"))).toThrow(/cannot be a playbook id/);
    expect(() => validateSkill(of("---\nname: x\ndescription: d\n---\n"))).toThrow(/body is empty/);
    expect(validateSkill(of(skill("ok")))).toMatchObject({ id: "ok", when: "when ok is asked for" });
  });
});

describe("installPlaybook", () => {
  it("keeps the version it replaces, and undo brings it back", () => {
    const dir = tmp("install");
    const files = (body: string) => new Map([["SKILL.md", Buffer.from(skill("review", body))]]);
    expect(installPlaybook(dir, "review", files("first"), { source: "a", importedAt: 1 })).toEqual({ id: "review", version: 1, replaced: false });
    expect(installPlaybook(dir, "review", files("second"), { source: "a", importedAt: 2 })).toEqual({ id: "review", version: 2, replaced: true });
    expect(installPlaybook(dir, "review", files("third"), { source: "a", importedAt: 3 })).toMatchObject({ version: 3 });
    const loaded = loadPlaybookDir(dir);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ body: "third", origin: { source: "a", version: 3 } });
    expect(keptVersions(path.join(dir, "review"))).toEqual([1, 2]);
    uninstallLatest(dir, "review");
    expect(loadPlaybookDir(dir)[0]).toMatchObject({ body: "second", origin: { version: 2 } });
    expect(keptVersions(path.join(dir, "review"))).toEqual([1]);
    uninstallLatest(dir, "review");
    uninstallLatest(dir, "review");
    expect(fs.existsSync(path.join(dir, "review"))).toBe(false);
  });

  it("a hand-made folder of that id counts as version 1", () => {
    const dir = tmp("handmade");
    writeSkill(dir, "review", "mine");
    expect(installPlaybook(dir, "review", new Map([["SKILL.md", Buffer.from(skill("review", "theirs"))]]), { source: "b", importedAt: 1 })).toMatchObject({ version: 2, replaced: true });
    expect(readOrigin(path.join(dir, "review"))).toMatchObject({ version: 2 });
    expect(fs.readFileSync(path.join(dir, "review", ".versions", "1", "SKILL.md"), "utf8")).toContain("mine");
  });
});

describe("import_playbook", () => {
  async function boot(storageDir?: string) {
    const playbooksDir = tmp("user-playbooks");
    const fakeStorage = {
      name: "fake-storage",
      apply(ctx: Context) {
        ctx.provide("storage", { artifactDirFor: () => storageDir ?? null });
      }
    };
    const base = await fresh({
      plugins: [Tools, [Settings, { path: path.join(root, `settings-${n++}.json`) }], fakeChat(new FakeChatModel([{ text: "ok" }])), [Agent, { playbooksDir }], ...(storageDir ? [fakeStorage] : [])]
    });
    await settle();
    return { ...base, agent: base.ctx.agent, playbooksDir };
  }

  it("imports a folder for this person, indexes it with its origin, and undo takes it back", async () => {
    const { ctx, agent, project } = await boot();
    const src = writeSkill(tmp("src"), "acme.review", "Look closely.");
    const result = (await ctx.tools.execute("import_playbook", { source: src, scope: "user" }, { by: "ai:test", projectId: project.id })) as { imported: { id: string; version: number }[] };
    expect(result.imported).toEqual([expect.objectContaining({ id: "acme.review", version: 1 })]);
    const entry = agent.playbookIndex().find((e) => e.id === "acme.review");
    expect(entry).toMatchObject({ source: "user", origin: { source: src, version: 1 } });
    expect(agent.openPlaybook("acme.review")).toBe("Look closely.");
    await agent.revertPlaybookImport({ scope: "user" }, result as never);
    expect(agent.playbookIndex().some((e) => e.id === "acme.review")).toBe(false);
  });

  it("imports into the project folder, and refuses the whole batch when one skill is bad", async () => {
    const storage = tmp("project-artifact");
    const { agent, project } = await boot(storage);
    const parent = tmp("many");
    writeSkill(parent, "good");
    fs.mkdirSync(path.join(parent, "bad"));
    fs.writeFileSync(path.join(parent, "bad", "SKILL.md"), "---\nname: bad\n---\n\nno description");
    await expect(agent.importPlaybooks({ source: parent, scope: "project", projectId: project.id })).rejects.toThrow(/no description/);
    expect(fs.existsSync(path.join(storage, "playbooks"))).toBe(false);
    const ok = await agent.importPlaybooks({ source: parent, scope: "project", projectId: project.id, pick: ["good"] });
    expect(ok.imported.map((i) => i.id)).toEqual(["good"]);
    expect(agent.playbookIndex(project.id).find((e) => e.id === "good")).toMatchObject({ source: "project" });
    const preview = await agent.previewPlaybookImport(parent);
    expect(preview.find((p) => p.id === "bad")?.problem).toMatch(/no description/);
  });
});
