import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

/** Installation is product-owned and reproducible across engines and resumes. */
export const ARCHIFY_REVISION = "d673e8300df60a5c8166abe78787fdc78f6b8000";
const REPOSITORY = "https://github.com/tt-a1i/archify.git";
const exec = promisify(execFile);
export const diagramTypes = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const;
export type DiagramType = typeof diagramTypes[number];
const examples: Record<DiagramType, string> = {
  architecture: "web-app.architecture.json",
  workflow: "agent-tool-call.workflow.json",
  sequence: "cache-miss-request.sequence.json",
  dataflow: "product-analytics.dataflow.json",
  lifecycle: "agent-run.lifecycle.json"
};

export class ArchifyRuntime {
  private installation?: Promise<string>;
  constructor(private readonly cacheDirectory: string, private readonly nodeBinary = process.execPath) {}

  /** A failed install can retry; no task ever updates a previously selected revision. */
  ensureInstalled(): Promise<string> {
    if (!this.installation) this.installation = this.install().catch(error => {
      this.installation = undefined;
      throw error;
    });
    return this.installation;
  }

  private async install(): Promise<string> {
    const target = path.join(this.cacheDirectory, ARCHIFY_REVISION);
    const skill = path.join(target, "archify");
    try {
      const head = await exec("git", ["-C", target, "rev-parse", "HEAD"]);
      if (head.stdout.trim() !== ARCHIFY_REVISION) throw new Error("Unexpected Archify revision");
      await fs.access(path.join(skill, "bin/archify.mjs"));
      return skill;
    } catch (error) {
      try { await fs.access(target); } catch { return this.installFresh(target); }
      throw error;
    }
  }

  private async installFresh(target: string): Promise<string> {
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    const staging = await fs.mkdtemp(path.join(this.cacheDirectory, "install-"));
    try {
      const options = { timeout: 120_000, maxBuffer: 2 * 1024 * 1024 };
      await exec("git", ["init", staging], options);
      await exec("git", ["-C", staging, "fetch", "--depth=1", REPOSITORY, ARCHIFY_REVISION], options);
      await exec("git", ["-C", staging, "checkout", "--detach", "FETCH_HEAD"], options);
      await this.command(path.join(staging, "archify"), ["doctor"]);
      try { await fs.rename(staging, target); } catch (error) {
        // Another app process may have installed the same revision while we fetched.
        const head = await exec("git", ["-C", target, "rev-parse", "HEAD"]);
        if (head.stdout.trim() !== ARCHIFY_REVISION) throw error;
      }
      return path.join(target, "archify");
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private command(skill: string, args: string[], signal?: AbortSignal) {
    return exec(this.nodeBinary, [path.join(skill, "bin/archify.mjs"), ...args], {
      cwd: skill, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, signal,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ARCHIFY_UPDATE_CHECK_DISABLED: "1" }
    });
  }

  async schema(type: DiagramType) {
    if (!diagramTypes.includes(type)) throw new Error("Unknown diagram type");
    const skill = await this.ensureInstalled();
    const read = async (name: string) => JSON.parse(await fs.readFile(path.join(skill, name), "utf8"));
    return {
      revision: ARCHIFY_REVISION, type,
      schema: await read(`schemas/${type}.schema.json`),
      common: await read("schemas/common.schema.json"),
      example: await read(`examples/${examples[type]}`)
    };
  }

  /** Caller provides a fresh artifact directory, never an arbitrary output filename. */
  async render(type: DiagramType, spec: Record<string, unknown>, directory: string, signal?: AbortSignal) {
    if (!diagramTypes.includes(type)) throw new Error("Unknown diagram type");
    const skill = await this.ensureInstalled();
    signal?.throwIfAborted();
    await fs.mkdir(directory, { recursive: true });
    const source = path.join(directory, "diagram.json");
    const artifact = path.join(directory, "diagram.html");
    await fs.writeFile(source, JSON.stringify(spec, null, 2), { flag: "wx" });
    try {
      const result = await this.command(skill, ["deliver", type, source, artifact, "--quality", "showcase", "--json"], signal);
      return { ok: true as const, source, artifact, receipt: JSON.parse(result.stdout), revision: ARCHIFY_REVISION };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; message?: string };
      let diagnostics: unknown;
      try { diagnostics = JSON.parse(failure.stdout ?? ""); } catch { diagnostics = failure.stderr || failure.message || String(error); }
      return { ok: false as const, diagnostics, revision: ARCHIFY_REVISION };
    }
  }
}
