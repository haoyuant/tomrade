import path from "node:path";
import { findExecutable, type MachineHost } from "./git.js";

export interface NpmStatus {
  state: "ready" | "missing" | "broken";
  version?: string;
  path?: string;
  error?: string;
}

const names = (platform: NodeJS.Platform): string[] => (platform === "win32" ? ["npm.cmd", "npm.exe"] : ["npm"]);

/** Folders Node installers put npm in, looked at after PATH. */
function knownDirs(host: MachineHost): string[] {
  if (host.platform === "win32") {
    const bases = [host.env.ProgramFiles && path.join(host.env.ProgramFiles, "nodejs"), host.env.APPDATA && path.join(host.env.APPDATA, "npm")];
    return bases.filter((base): base is string => !!base);
  }
  if (host.platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"];
  return ["/usr/local/bin"];
}

/** The npm agent installs would use; a folder PATH misses is adopted so the installs find it too. */
export async function probeNpm(host: MachineHost): Promise<NpmStatus> {
  const found = await findExecutable(host, names(host.platform), knownDirs(host));
  if (!found) return { state: "missing" };
  const version = await host.run(found.file, ["--version"], 15_000);
  if (version.code !== 0) {
    return { state: "broken", path: found.file, error: version.error ?? (version.output.trim() || `exit ${version.code}`) };
  }
  if (!found.onPath) host.adoptPath(path.dirname(found.file));
  return { state: "ready", path: found.file, version: version.output.trim() };
}
