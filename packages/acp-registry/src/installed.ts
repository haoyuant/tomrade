import fs from "node:fs";
import path from "node:path";
import type { LocalCliStatus } from "@tomradex/agent";
import { CliLocator, localCli, type CliHost } from "@tomradex/engine-kit";

/** `@scope/name@1.2.3` as its name and version; no version: any one installed will do. */
export function packageOf(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

/**
 * npx, counted as found only once the pinned package is installed globally
 * with the npm Tomrade uses. npx then runs that copy at once and offline (it
 * looks in npm's global folder before its own cache), so a first turn never
 * downloads the package inside its time limit. The status names the package,
 * its folder and its version; launching is npx's.
 */
export class NpxPackage extends CliLocator {
  private root: { at: number; dir: string | null } | null = null;

  constructor(
    readonly pkg: string,
    host?: CliHost,
    private npm: Pick<CliLocator, "run"> = localCli("npm")
  ) {
    super("npx", host);
  }

  /** npm's global folder, as that npm says; asked again on a fresh look. */
  private async globalRoot(fresh = false): Promise<string | null> {
    if (!fresh && this.root && Date.now() - this.root.at < 5 * 60_000) return this.root.dir;
    const result = await this.npm.run(undefined, ["root", "-g"], 15_000).catch(() => null);
    const dir = result?.code === 0 ? (result.stdout.trim().split(/\r?\n/).at(-1)?.trim() ?? "") : "";
    this.root = { at: Date.now(), dir: dir || null };
    return this.root.dir;
  }

  override async locate(opts: { manual?: string; fresh?: boolean } = {}): Promise<LocalCliStatus> {
    const npx = await super.locate(opts);
    if (npx.state !== "ready") return npx;
    const { name, version } = packageOf(this.pkg);
    const root = await this.globalRoot(opts.fresh);
    const dir = root ? path.join(root, ...name.split("/")) : null;
    let installed: string | undefined;
    try {
      if (dir) installed = String((JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { version?: unknown }).version ?? "");
    } catch {
      installed = undefined;
    }
    if (installed !== undefined && (!version || installed === version)) return { ...npx, name: this.pkg, path: dir!, version: installed };
    const { path: _path, version: _version, source: _source, ...rest } = npx;
    return { ...rest, name: this.pkg, state: "missing" };
  }
}
