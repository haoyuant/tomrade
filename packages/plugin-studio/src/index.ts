import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "cordis";
import { z } from "zod";
import { loadPlaybookDir } from "@tomradex/agent";
import type {} from "@tomradex/db";
import type {} from "@tomradex/ipc";
import { build, check, pack, scaffold, test, type CheckReport } from "@tomradex/plugin-cli";
import { dataDirFor, packageDigest, readManifest, type Analysis } from "@tomradex/plugin-kit";
import { MANIFEST_FILE, namespaceOf, riskOf, type Dictionaries, type LanguageCoverage, type Manifest, type Risk } from "@tomradex/plugin-sdk";
import type { PluginView, Plugins } from "@tomradex/plugins";
import { defineTool } from "@tomradex/tools";
import { contract, errorMessage } from "@tomradex/contracts";

export const Config = z.preprocess(
  (v) => v ?? {},
  z.object({
    /** Where the agent's plugins are written: one folder each, a git repository the person owns. */
    devRoot: z.string(),
    /** The publisher part of a new plugin's id until it is published under a GitHub login. */
    publisher: z.string().default("local"),
    /** The binary that runs a plugin's check and tests as Node; defaults to the running one. */
    nodeBinary: z.string().default(process.execPath)
  })
);
export type Config = z.infer<typeof Config>;

export interface Workspace {
  name: string;
  dir: string;
  id: string;
  title: string;
  version: string;
  description: string;
  authoredBy: Manifest["authoredBy"];
  /** The row, once the workspace has been handed to the plugin manager. */
  view: PluginView | null;
}

/** What a person sees before allowing a build to load. */
export interface Review {
  id: string;
  digest: string;
  analysis: Analysis | null;
  risk: Risk;
  permissions: Manifest["permissions"];
  inject: string[];
  /** What the last confirmed build could reach, to show what changed. */
  previous: { version: string; permissions: Manifest["permissions"]; inject: string[] } | null;
  /** Lines of the bundle that differ from the last confirmed build. */
  diff: { added: number; removed: number } | null;
}

declare module "@tomradex/ipc" {
  interface Channels {
    "studio.list": () => Workspace[];
    "studio.create": (input: { projectId: string; name: string; title?: string; description: string; engine?: string }) => { threadId: string; dir: string };
    "studio.continue": (input: { projectId: string; name: string; engine?: string; message?: string }) => { threadId: string };
    "studio.review": (name: string) => Review;
    "studio.confirm": (name: string, digest: string) => { snapshot: string | null };
    "studio.snapshots": (name: string) => { file: string; at: number; rows: number }[];
    "studio.restore": (name: string, file: string) => { rows: number };
    "studio.pack": (name: string) => { file: string | null; report: CheckReport };
    "studio.remove": (name: string, deleteFiles: boolean) => void;
  }
  interface Broadcasts {
    /** A build is waiting for a person to look at it. */
    "studio.pending": (id: string, digest: string) => void;
    "studio.changed": () => void;
  }
}

const NAME = /^[a-z][a-z0-9-]{1,40}$/;
const WRITABLE = [/^src\/[\w./-]+$/, /^static\/[\w./-]+$/, /^tests\/[\w./-]+$/, /^README\.md$/, new RegExp(`^${MANIFEST_FILE.replace(".", "\\.")}$`)];
const MAX_FILE = 200_000;
const LOG_LINES = 200;
const SNAPSHOTS_KEPT = 5;

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");


/**
 * Plugin Studio: where an agent writes a plugin for the person it works with.
 * The agent gets tools confined to one workspace folder; its code runs only in
 * the sandbox until a person confirms an exact build, and every later change
 * waits for confirmation again.
 */
export default {
  name: "plugin-studio",
  inject: ["tools"],
  Config,
  apply(ctx: Context, config: Config) {
    fs.mkdirSync(config.devRoot, { recursive: true });
    const manager = (): Plugins => {
      const plugins = ctx.get("plugins") as Plugins | undefined;
      if (!plugins?.extensions) throw new Error("the plugin manager is not running");
      return plugins;
    };
    const store = () => manager().extensions!;

    const dirOf = (name: string): string => {
      if (!NAME.test(name)) throw new Error(`"${name}" is not a workspace name: lowercase letters, digits and dashes`);
      const dir = path.join(config.devRoot, name);
      if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) throw new Error(`there is no plugin "${name}" in Plugin Studio; create it with plugin_create`);
      return dir;
    };
    const idOf = (dir: string) => readManifest(dir).id;
    const viewOf = (id: string) => manager().snapshot().plugins.find((p) => p.id === id) ?? null;
    const notify = () => ctx.get("ipc")?.send("studio.changed");

    // A plugin's own log lines, and the manager's lines about it, for plugin_logs.
    const logs = new Map<string, string[]>();
    const known = () => new Set(fs.readdirSync(config.devRoot).flatMap((name) => (fs.existsSync(path.join(config.devRoot, name, MANIFEST_FILE)) ? [safeId(path.join(config.devRoot, name))] : [])));
    const safeId = (dir: string) => {
      try {
        return idOf(dir);
      } catch {
        return "";
      }
    };
    let watched = known();
    ctx.effect(() => {
      const refresh = setInterval(() => (watched = known()), 5_000);
      const exporter = ctx.root.logger.exporter({
        export(message) {
          const first = String(message.args[0] ?? "");
          const id = watched.has(message.name) ? message.name : [...watched].find((w) => first.startsWith(`${w}:`));
          if (!id) return;
          const lines = logs.get(id) ?? [];
          lines.push(`${new Date(message.ts).toISOString()} ${message.type} ${message.args.map((a) => (a instanceof Error ? a.message : typeof a === "string" ? a : JSON.stringify(a))).join(" ")}`);
          logs.set(id, lines.slice(-LOG_LINES));
        }
      });
      return () => {
        clearInterval(refresh);
        void exporter();
      };
    }, "studio.logs");

    const list = (): Workspace[] =>
      fs
        .readdirSync(config.devRoot, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(config.devRoot, e.name, MANIFEST_FILE)))
        .flatMap((e) => {
          const dir = path.join(config.devRoot, e.name);
          try {
            const m = readManifest(dir);
            return [{ name: e.name, dir, id: m.id, title: m.title, version: m.version, description: m.description, authoredBy: m.authoredBy, view: viewOf(m.id) }];
          } catch {
            return [];
          }
        });

    const create = (name: string, title: string | undefined, description: string) => {
      if (!NAME.test(name)) throw new Error(`"${name}" is not a workspace name: lowercase letters, digits and dashes`);
      const dir = path.join(config.devRoot, name);
      if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir;
      const publisher = contract(ctx, "community")?.publisherLogin?.() ?? config.publisher;
      scaffold(dir, { id: `${publisher}/${name}`, title, description, authoredBy: "agent" });
      watched = known();
      notify();
      return dir;
    };

    const inside = (dir: string, rel: string) => {
      const file = path.resolve(dir, rel);
      const back = path.relative(dir, file);
      if (back.startsWith("..") || path.isAbsolute(back)) throw new Error(`${rel} is outside the workspace`);
      return { file, rel: back.split(path.sep).join("/") };
    };

    // What a language pack translates: the backend's books, and the interface's once a window has said.
    const english = () => contract(ctx, "settings")?.english?.();
    const coverageOf = (coverage: LanguageCoverage | null, source: Dictionaries | null | undefined) => {
      if (!coverage || !source) return null;
      const englishOf = (key: string) => {
        const at = key.indexOf(".");
        return source[key.slice(0, at)]?.[key.slice(at + 1)] ?? "";
      };
      return {
        translated: coverage.translated,
        total: coverage.total,
        missing: coverage.missing.length,
        // The next strings to translate, with the English they stand for.
        next: Object.fromEntries(coverage.missing.slice(0, 40).map((key) => [key, englishOf(key)])),
        stale: coverage.stale,
        slotMismatches: coverage.slotMismatches
      };
    };
    const summary = (report: CheckReport, words = english()) => ({
      verdict: report.verdict,
      problems: report.problems,
      findings: report.analysis?.findings.map((f) => `[${f.severity}] ${f.rule}: ${f.message} (${f.file}:${f.line})`) ?? [],
      risk: report.risk,
      contributes: report.manifest?.contributes,
      ...(report.imAdapters.length ? { imAdapters: report.imAdapters } : {}),
      ...(report.languages.length
        ? { languages: report.languages.map((l) => ({ tag: l.tag, name: l.name, ui: coverageOf(l.ui, words?.ui), backend: coverageOf(l.backend, words?.backend) })) }
        : {}),
      ...(report.notes.length ? { notes: report.notes } : {}),
      beforePublishing: report.publishing
    });

    ctx.tools.kit("plugins", "build a Tomrade plugin");
    const reg = (tool: Parameters<typeof ctx.tools.register>[0]) => ctx.tools.register({ ...tool, kit: "plugins" });
    const plugin = z.string().describe("The workspace name, as plugin_create returned it");

    reg(
      defineTool({
        name: "plugin_create",
        title: "Start a plugin",
        description: "Create a new plugin workspace in Plugin Studio from the template (a tool, a status item and a test scenario). Returns its folder and namespace. Does nothing if the workspace exists.",
        input: z.object({ name: z.string().describe("Short kebab-case name, e.g. stale-issues"), title: z.string().optional(), description: z.string().describe("One sentence: what the plugin does") }),
        execute: ({ name, title, description }) => {
          const dir = create(name, title, description);
          const m = readManifest(dir);
          return { plugin: name, id: m.id, namespace: namespaceOf(m), dir, files: list().find((w) => w.name === name) ? fs.readdirSync(path.join(dir, "src")).map((f) => `src/${f}`) : [] };
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_reference",
        title: "Plugin SDK reference",
        description: "The plugin SDK: the shape of a plugin, every service and its calls, the manifest and the test scenario. Read once before writing code; pass types:true for the exact TypeScript declarations.",
        input: z.object({ types: z.boolean().optional() }),
        execute: ({ types }) => {
          const text = fs.readFileSync(path.join(packageRoot, "reference", "sdk.md"), "utf8");
          if (!types) return text;
          const dts = path.join(path.dirname(fileURLToPath(import.meta.resolve("@tomradex/plugin-sdk"))), "contract.d.ts");
          return `${text}\n\n## contract.d.ts\n\n\`\`\`ts\n${fs.existsSync(dts) ? fs.readFileSync(dts, "utf8") : "(not built)"}\n\`\`\``;
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_files",
        title: "List a plugin's files",
        description: "The files of a Plugin Studio workspace, with sizes. dist/ is the build and is not edited by hand.",
        input: z.object({ plugin }),
        execute: ({ plugin: name }) => {
          const dir = dirOf(name);
          const out: { path: string; bytes: number }[] = [];
          const walk = (abs: string, rel: string) => {
            for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
              if (e.name === "node_modules" || e.name === ".git") continue;
              const r = rel ? `${rel}/${e.name}` : e.name;
              if (e.isDirectory()) walk(path.join(abs, e.name), r);
              else if (e.isFile()) out.push({ path: r, bytes: fs.statSync(path.join(abs, e.name)).size });
            }
          };
          walk(dir, "");
          return out;
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_read",
        title: "Read a plugin file",
        description: "Read one file of a Plugin Studio workspace.",
        input: z.object({ plugin, path: z.string() }),
        execute: ({ plugin: name, path: rel }) => {
          const { file } = inside(dirOf(name), rel);
          if (!fs.existsSync(file)) throw new Error(`${rel} does not exist`);
          return fs.readFileSync(file, "utf8");
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_write",
        title: "Write a plugin file",
        description: "Write a whole file in a Plugin Studio workspace: src/**, static/**, tests/**, README.md or tomrade-plugin.json. Nothing it writes runs until a person confirms a build.",
        input: z.object({ plugin, path: z.string(), content: z.string() }),
        execute: ({ plugin: name, path: rel, content }) => {
          const dir = dirOf(name);
          const target = inside(dir, rel);
          if (!WRITABLE.some((re) => re.test(target.rel))) throw new Error(`${target.rel} is not a file the agent writes; use src/, static/, tests/, README.md or ${MANIFEST_FILE}`);
          if (Buffer.byteLength(content) > MAX_FILE) throw new Error(`${target.rel} is larger than ${MAX_FILE} bytes`);
          if (target.rel === MANIFEST_FILE) {
            const next = JSON.parse(content) as { id?: string };
            if (next.id !== idOf(dir)) throw new Error("the plugin's id is set when it is published; leave it as it is");
          }
          fs.mkdirSync(path.dirname(target.file), { recursive: true });
          fs.writeFileSync(target.file, content);
          return { wrote: target.rel, bytes: Buffer.byteLength(content) };
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_build",
        title: "Build a plugin",
        description: "Bundle the workspace's src/ into dist/. Returns build errors with file:line. Runs none of the plugin's code.",
        input: z.object({ plugin }),
        execute: async ({ plugin: name }) => {
          const result = await build(dirOf(name));
          return { ok: result.ok, errors: result.errors, warnings: result.warnings, bundled: result.bundled };
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_test",
        title: "Test a plugin",
        description: "Build, then run the plugin against a throwaway project in a sandbox that cannot write to disk or start programs: loads it, computes its badges/sections/status items/graphs, and runs src/test.ts. The person's data is never touched.",
        input: z.object({ plugin }),
        execute: async ({ plugin: name }) => test(dirOf(name), { execPath: config.nodeBinary })
      })
    );
    reg(
      defineTool({
        name: "plugin_check",
        title: "Check a plugin",
        description: "Build, inspect in the sandbox and read the code: namespace problems, what the code does compared with what the manifest says, risk, and what stands before publishing.",
        input: z.object({ plugin }),
        execute: async ({ plugin: name }) => summary(await check(dirOf(name), { execPath: config.nodeBinary, english: english() }))
      })
    );
    reg(
      defineTool({
        name: "plugin_try",
        title: "Ask to load a plugin",
        description: "Check the workspace, then ask the person to confirm loading this exact build into Tomrade. Returns at once; it loads only when they confirm. Every later change needs a new confirmation.",
        input: z.object({ plugin }),
        execute: async ({ plugin: name }) => {
          const dir = dirOf(name);
          const report = await check(dir, { execPath: config.nodeBinary, english: english() });
          if (report.verdict === "blocked") return { waiting: false, ...summary(report) };
          const id = idOf(dir);
          await manager().addFolder(dir, "studio");
          const digest = packageDigest(dir);
          const view = viewOf(id);
          if (view?.state === "active") return { waiting: false, loaded: true, message: "This build is already confirmed and running." };
          ctx.get("ipc")?.send("studio.pending", id, digest);
          notify();
          return { waiting: true, digest: digest.slice(0, 12), message: "Tomrade is asking the person to confirm this build. Tell them what it does and what it can reach, then wait; plugin_status says when it is running.", ...summary(report) };
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_status",
        title: "Plugin status",
        description: "Whether the plugin is running, waiting for confirmation, off or failed (with the error), and its last log lines.",
        input: z.object({ plugin }),
        execute: ({ plugin: name }) => {
          const dir = dirOf(name);
          const id = idOf(dir);
          const view = viewOf(id);
          const pending = view?.extension?.pending;
          const state = !view ? "not handed over (call plugin_try)" : pending ? "waiting for the person to confirm" : view.state;
          return { id, state, error: view?.error, waitingFor: view?.waitingFor, provides: view?.provides, tier: view?.extension?.tier, logs: (logs.get(id) ?? []).slice(-20) };
        }
      })
    );
    reg(
      defineTool({
        name: "plugin_logs",
        title: "Plugin logs",
        description: "The plugin's recent log lines, and the manager's lines about loading it.",
        input: z.object({ plugin, limit: z.number().int().min(1).max(LOG_LINES).optional() }),
        execute: ({ plugin: name, limit }) => (logs.get(idOf(dirOf(name))) ?? []).slice(-(limit ?? 50))
      })
    );

    const agentThread = async (projectId: string, engine: string | undefined, title: string, text: string) => {
      const agent = ctx.get("agent");
      if (!agent) throw new Error("the assistant is not running");
      const thread = agent.newThread(projectId, engine, null, { title });
      agent.send(projectId, thread.id, { kind: "text", text });
      return thread.id;
    };

    const dataDir = (id: string) => dataDirFor(store().root, id);

    const review = (name: string): Review => {
      const dir = dirOf(name);
      const manifest = readManifest(dir);
      const info = store().has(manifest.id) ? store().info(manifest.id) : null;
      const confirmedManifest = path.join(dataDir(manifest.id), "confirmed-manifest.json");
      const confirmedBundle = path.join(dataDir(manifest.id), "confirmed.js");
      const previous = fs.existsSync(confirmedManifest) ? (JSON.parse(fs.readFileSync(confirmedManifest, "utf8")) as Manifest) : null;
      let diff: Review["diff"] = null;
      if (manifest.main !== null && fs.existsSync(confirmedBundle) && fs.existsSync(path.join(dir, manifest.main))) {
        const before = fs.readFileSync(confirmedBundle, "utf8").split("\n");
        const after = fs.readFileSync(path.join(dir, manifest.main), "utf8").split("\n");
        const count = (lines: string[]) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map<string, number>());
        const a = count(before);
        const b = count(after);
        let added = 0;
        let removed = 0;
        for (const [line, n] of b) added += Math.max(0, n - (a.get(line) ?? 0));
        for (const [line, n] of a) removed += Math.max(0, n - (b.get(line) ?? 0));
        diff = { added, removed };
      }
      return {
        id: manifest.id,
        digest: info?.pending?.digest ?? packageDigest(dir, manifest),
        analysis: info?.pending?.analysis ?? null,
        risk: riskOf(manifest),
        permissions: manifest.permissions,
        inject: [...manifest.inject, ...manifest.optional],
        previous: previous ? { version: previous.version, permissions: previous.permissions, inject: [...previous.inject, ...previous.optional] } : null,
        diff
      };
    };

    /** The plugin's own tables, per open project and in the Hub, as they are before a new build runs. */
    const snapshot = (id: string): string | null => {
      const db = ctx.get("db");
      if (!db) return null;
      const ns = namespaceOf(readManifest(store().entry(id).dir));
      const tables: Record<string, Record<string, unknown[]>> = {};
      let rows = 0;
      for (const target of ["hub", ...db.openIds()]) {
        const handle = target === "hub" ? db.hub : db.for(target);
        for (const { name } of handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?").all(`plugin_${ns}_%`) as { name: string }[]) {
          const all = handle.prepare(`SELECT * FROM "${name}"`).all();
          if (!all.length) continue;
          (tables[target] ??= {})[name] = all;
          rows += all.length;
        }
      }
      if (!rows) return null;
      const dir = path.join(dataDir(id), "snapshots");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${Date.now()}.json`);
      fs.writeFileSync(file, JSON.stringify({ id, rows, tables }));
      for (const old of fs.readdirSync(dir).sort().slice(0, -SNAPSHOTS_KEPT)) fs.rmSync(path.join(dir, old), { force: true });
      return file;
    };

    ctx.inject(["ipc"], (inner) => {
      inner.ipc.handle("studio.list", () => list());
      inner.ipc.handle("studio.create", async ({ projectId, name, title, description, engine }) => {
        const dir = create(name, title, description);
        const threadId = await agentThread(
          projectId,
          engine,
          `Plugin · ${title ?? name}`,
          `Build this Tomrade plugin in the Plugin Studio workspace "${name}": ${description}\n\nOpen the playbook studio.build-plugin first and follow it.`
        );
        return { threadId, dir };
      });
      inner.ipc.handle("studio.continue", async ({ projectId, name, engine, message }) => {
        const dir = dirOf(name);
        const m = readManifest(dir);
        const threadId = await agentThread(projectId, engine, `Plugin · ${m.title}`, `${message ?? "Continue working on"} the Plugin Studio workspace "${name}" (${m.id}).\n\nOpen the playbook studio.build-plugin first and follow it.`);
        return { threadId };
      });
      inner.ipc.handle("studio.review", (name) => review(name));
      inner.ipc.handle("studio.confirm", async (name, digest) => {
        const dir = dirOf(name);
        const id = idOf(dir);
        const file = store().has(id) ? snapshot(id) : null;
        await manager().confirm(id, digest);
        const manifest = readManifest(dir);
        fs.mkdirSync(dataDir(id), { recursive: true });
        fs.writeFileSync(path.join(dataDir(id), "confirmed-manifest.json"), JSON.stringify(manifest));
        if (manifest.main !== null) fs.copyFileSync(path.join(dir, manifest.main), path.join(dataDir(id), "confirmed.js"));
        notify();
        return { snapshot: file };
      });
      inner.ipc.handle("studio.snapshots", (name) => {
        const dir = path.join(dataDir(idOf(dirOf(name))), "snapshots");
        if (!fs.existsSync(dir)) return [];
        return fs
          .readdirSync(dir)
          .sort()
          .reverse()
          .map((f) => ({ file: path.join(dir, f), at: Number(f.replace(/\.json$/, "")), rows: (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { rows: number }).rows }));
      });
      inner.ipc.handle("studio.restore", (name, file) => {
        const id = idOf(dirOf(name));
        const dir = path.join(dataDir(id), "snapshots");
        if (path.dirname(path.resolve(file)) !== path.resolve(dir)) throw new Error("that is not one of this plugin's snapshots");
        const saved = JSON.parse(fs.readFileSync(file, "utf8")) as { tables: Record<string, Record<string, Record<string, unknown>[]>> };
        const db = ctx.get("db");
        if (!db) throw new Error("the database is not running");
        let rows = 0;
        for (const [target, tables] of Object.entries(saved.tables)) {
          if (target !== "hub" && !db.has(target)) continue;
          const handle = target === "hub" ? db.hub : db.for(target);
          handle.transaction(() => {
            for (const [table, all] of Object.entries(tables)) {
              const columns = new Set((handle.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]).map((c) => c.name));
              if (!columns.size) continue;
              handle.prepare(`DELETE FROM "${table}"`).run();
              for (const row of all) {
                const keys = Object.keys(row).filter((k) => columns.has(k));
                handle.prepare(`INSERT INTO "${table}" (${keys.map((k) => `"${k}"`).join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...keys.map((k) => row[k]));
                rows += 1;
              }
            }
          });
        }
        return { rows };
      });
      inner.ipc.handle("studio.pack", async (name) => {
        const dir = dirOf(name);
        const m = readManifest(dir);
        const { file, report } = await pack(dir, { out: path.join(dir, `${m.id.replace("/", "-")}-${m.version}.tomrade-plugin`) });
        return { file, report };
      });
      inner.ipc.handle("studio.remove", async (name, deleteFiles) => {
        const dir = dirOf(name);
        const id = idOf(dir);
        if (store().has(id)) await manager().uninstall(id, { removeData: deleteFiles });
        if (deleteFiles) fs.rmSync(dir, { recursive: true, force: true });
        watched = known();
        notify();
      });
    });

    ctx.inject(["agent"], (inner) => {
      for (const playbook of loadPlaybookDir(path.join(packageRoot, "playbooks"), (file, err) => ctx.logger("plugin-studio").warn(`${file}: ${errorMessage(err)}`))) inner.agent.playbook(playbook);
    });
  }
};
