import fs from "node:fs";
import path from "node:path";
import type { LocalCliStatus } from "@tomradex/agent";
import { CliLocator, localCli, machineHost, type CliHost } from "@tomradex/engine-kit";

/** `@scope/name@1.2.3` as its name and version; no version: any one installed will do. */
export function packageOf(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

/**
 * npx, counted as found only once the pinned package is installed globally
 * with the npm Tomrade uses, or under Tomrade's own npm prefix. npx then runs that copy at once and offline (it
 * looks in npm's global folder before its own cache), so a first turn never
 * downloads the package inside its time limit. The status names the package,
 * its folder and its version; launching is npx's.
 */
export class NpxPackage extends CliLocator {
  private root: { at: number; dir: string | null } | null = null;
  /** Tomrade's own npm prefix when the package was found there (a refused `npm i -g` lands it there): npx is pointed at it. */
  prefix: string | null = null;

  constructor(
    readonly pkg: string,
    private machine: CliHost = machineHost(),
    private npm: Pick<CliLocator, "run"> = localCli("npm")
  ) {
    super("npx", machine);
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
    const own = this.machine.env.TOMRADE_NPM_PREFIX;
    const p = this.machine.platform === "win32" ? path.win32 : path.posix;
    // npm keeps global packages in `<prefix>/lib/node_modules`, on Windows in `<prefix>/node_modules`.
    const ownRoot = own ? (this.machine.platform === "win32" ? p.join(own, "node_modules") : p.join(own, "lib", "node_modules")) : null;
    for (const root of [await this.globalRoot(opts.fresh), ownRoot]) {
      if (!root) continue;
      const dir = p.join(root, ...name.split("/"));
      let installed: string;
      try {
        installed = String((JSON.parse(fs.readFileSync(p.join(dir, "package.json"), "utf8")) as { version?: unknown }).version ?? "");
      } catch {
        continue;
      }
      if (version && installed !== version) continue;
      this.prefix = root === ownRoot ? own! : null;
      return { ...npx, name: this.pkg, path: dir, version: installed };
    }
    this.prefix = null;
    const { path: _path, version: _version, source: _source, ...rest } = npx;
    return { ...rest, name: this.pkg, state: "missing" };
  }
}
