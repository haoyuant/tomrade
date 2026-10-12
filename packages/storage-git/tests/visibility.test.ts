/**
 * Conversations are for the people a project is shared with. Against a real
 * bare repository: a remote known to be public never gets a `private`
 * namespace — unticked when it is found public, kept off it if ticked again or
 * brought back by a teammate — while a private or unknown one gets it as
 * before, and this machine's own rows are never lost along the way.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Context } from "cordis";
import { fresh, settle } from "@tomradex/testkit";
import { ARTIFACT_DIR, Storage, digestState, readArtifact, writeArtifact, type RemoteVisibility } from "@tomradex/storage";
import storageGit, { createRemoteProvider } from "@tomradex/storage-git";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-visibility-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const git = (args: string[], cwd: string) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();

let n = 0;
function bareRemote(): string {
  const dir = path.join(root, `remote-${n++}.git`);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "--bare", "-b", "main", "."], dir);
  return dir;
}

/** A host that says whatever `answer` holds — or nothing at all. */
const answer: { value: RemoteVisibility | Error } = { value: "public" };
const hosted = {
  name: "hosted",
  inject: ["storage"],
  apply(ctx: Context) {
    ctx.storage.register(
      createRemoteProvider({
        id: "hosted",
        title: "A hosted repository",
        configSchema: z.object({ remote: z.string(), branch: z.string().default("main") }),
        defaults: { remote: "", branch: "main" },
        toRemote: (c) => ({ url: c.remote, branch: c.branch }),
        visibility: async () => {
          if (answer.value instanceof Error) throw answer.value;
          return answer.value;
        }
      })
    );
  }
};

/** `talk` is a conversation-like namespace; `notes` is ordinary project data. */
const plugins = {
  name: "talk-and-notes",
  inject: ["db"],
  apply(ctx: Context) {
    ctx.db.migrate("talk", [{ version: 1, up: "CREATE TABLE plugin_talk_lines (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
      tables: { plugin_talk_lines: { project: "project_id", export: { order: "id", private: true } } }
    });
    ctx.db.migrate("notes", [{ version: 1, up: "CREATE TABLE plugin_notes_pages (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT)" }], {
      tables: { plugin_notes_pages: { project: "project_id", export: { order: "id" } } }
    });
  }
};

async function machine(label: string, storage: Record<string, unknown> = {}) {
  const hubDir = path.join(root, `${label}-${n++}`);
  fs.mkdirSync(hubDir, { recursive: true });
  const bag = await fresh({ hubDir, plugins: [[Storage, { snapshotIdleMs: 60_000, snapshotMaxMs: 60_000, watch: false, reconcileMs: 0, ...storage }], storageGit, hosted, plugins] });
  await settle();
  await bag.ctx.storage.ready;
  const id = bag.project.id;
  const db = bag.ctx.db.for(id);
  db.prepare("INSERT INTO plugin_talk_lines (id, project_id, body) VALUES ('t1', ?, 'what we said')").run(id);
  db.prepare("INSERT INTO plugin_notes_pages (id, project_id, body) VALUES ('p1', ?, 'a page')").run(id);
  await bag.ctx.storage.setExports(id, ["notes", "talk"]);
  const talk = () => db.prepare("SELECT id, body FROM plugin_talk_lines ORDER BY id").all();
  return { ...bag, storage: bag.ctx.storage, dir: bag.hub.catalog.project(id)!.dir!, talk };
}

const pushed = (remote: string, ref = "main") => git(["ls-tree", "-r", "--name-only", ref, `${ARTIFACT_DIR}/plugins/`], remote).split("\n").filter(Boolean);
const TALK = `${ARTIFACT_DIR}/plugins/talk/plugin_talk_lines.jsonl`;
const NOTES = `${ARTIFACT_DIR}/plugins/notes/plugin_notes_pages.jsonl`;

describe("a remote anyone can read", () => {
  it("never gets conversations: unticked when it is found public, and not a choice while it is", async () => {
    answer.value = "public";
    const a = await machine("public");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "hosted", { remote, branch: "main" });
    expect(pushed(remote)).toEqual([NOTES]);
    expect(JSON.parse(git(["show", `main:${ARTIFACT_DIR}/project.json`], remote)).exports).toEqual(["notes"]);
    const info = await a.storage.info(a.project.id);
    expect(info.visibility).toBe("public");
    expect(info.exports).toEqual(["notes"]);
    expect(info.exportable.find((e) => e.namespace === "talk")?.private).toBe(true);
    // Ticking it again is refused, and the conversation is still here.
    expect((await a.storage.setExports(a.project.id, ["notes", "talk"])).exports).toEqual(["notes"]);
    await a.storage.sync(a.project.id);
    expect(pushed(remote)).toEqual([NOTES]);
    expect(a.talk()).toEqual([{ id: "t1", body: "what we said" }]);
  });

  it("drops them from the next push once a private repository turns public; history keeps what was pushed", async () => {
    answer.value = "private";
    const a = await machine("flip", { visibilityMs: 0 });
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "hosted", { remote, branch: "main" });
    expect(pushed(remote)).toEqual([NOTES, TALK]);
    answer.value = "public";
    a.ctx.db.for(a.project.id).prepare("INSERT INTO plugin_notes_pages (id, project_id, body) VALUES ('p2', ?, 'another')").run(a.project.id);
    await a.storage.publish(a.project.id);
    expect(pushed(remote)).toEqual([NOTES]);
    expect(pushed(remote, "main~1")).toContain(TALK);
    expect(a.talk()).toEqual([{ id: "t1", body: "what we said" }]);
    expect((await a.storage.info(a.project.id)).exports).toEqual(["notes"]);
  });

  it("keeps a teammate's re-ticking off it, and never trades this machine's conversations for theirs", async () => {
    answer.value = "public";
    const a = await machine("mate");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "hosted", { remote, branch: "main" });
    // A teammate on an older build ticks conversations back on and pushes theirs.
    const work = path.join(root, `mate-${n++}`);
    git(["clone", "-q", "--branch", "main", remote, work], root);
    git(["config", "user.email", "mate@localhost"], work);
    git(["config", "user.name", "Mate"], work);
    const state = readArtifact(work)!;
    state.manifest.exports = ["notes", "talk"];
    state.plugins.talk = { plugin_talk_lines: [{ id: "t9", project_id: a.project.id, body: "theirs" }] };
    state.manifest.snapshot!.digest = digestState(state);
    writeArtifact(work, state);
    git(["add", "-A"], work);
    git(["commit", "-q", "-m", "teammate"], work);
    git(["push", "-q", "origin", "HEAD:refs/heads/main"], work);

    await a.storage.sync(a.project.id);
    expect((await a.storage.info(a.project.id)).exports).toEqual(["notes"]);
    expect(a.talk()).toEqual([{ id: "t1", body: "what we said" }]);
    // And what they pushed there is taken out of the repository's current state again.
    a.ctx.db.for(a.project.id).prepare("INSERT INTO plugin_notes_pages (id, project_id, body) VALUES ('p3', ?, 'after')").run(a.project.id);
    await a.storage.publish(a.project.id);
    expect(pushed(remote)).toEqual([NOTES]);
  });
});

describe("a remote only some can read", () => {
  it("gets conversations as before when private, or when the host can't say", async () => {
    answer.value = "private";
    const a = await machine("private");
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "hosted", { remote, branch: "main" });
    expect(pushed(remote)).toEqual([NOTES, TALK]);
    expect((await a.storage.info(a.project.id)).visibility).toBe("private");

    const b = await machine("plain-git");
    const other = bareRemote();
    await b.storage.bind(b.project.id, "git", { remote: other, branch: "main" });
    expect(pushed(other)).toEqual([NOTES, TALK]);
    expect((await b.storage.info(b.project.id)).visibility).toBe("unknown");
  });

  it("keeps the last answer when the host doesn't give one", async () => {
    answer.value = "public";
    const a = await machine("silent", { visibilityMs: 0 });
    const remote = bareRemote();
    await a.storage.bind(a.project.id, "hosted", { remote, branch: "main" });
    answer.value = new Error("offline");
    await a.storage.sync(a.project.id);
    expect((await a.storage.info(a.project.id)).visibility).toBe("public");
    expect(pushed(remote)).toEqual([NOTES]);
  });
});
