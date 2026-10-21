import fs from "node:fs";
import path from "node:path";
import type { CliHost, CliLaunch } from "./locate.js";

/**
 * A copy of an agent's npm package that Tomrade installed in a folder of its
 * own and starts itself: a native bin directly, a script with Tomrade's own
 * runtime as Node. No PATH lookup, shim or shell stands between.
 */
export interface ManagedCli {
  /** The package's bin, as an absolute file. */
  file: string;
  version: string;
  /** The binary that runs a script bin as Node (with `ELECTRON_RUN_AS_NODE`). */
  runtime: string;
  /** A folder whose `node` is that runtime, added to the agent's PATH for the tools it starts. */
  nodeDir: string;
  /** For the agent alone, such as its self-updater switched off. */
  env?: Record<string, string>;
  /** Tried ahead of the person's own copy: theirs failed its test and this one passed, or this one is on trial. */
  prefer: boolean;
}

/**
 * What a bin file is, from its first bytes: a native program (`MZ`, ELF,
 * Mach-O), a Node script (a `.js` name or a `#!…node` line), or a
 * placeholder whose real program a postinstall never put in place.
 */
export type BinKind = "native" | "node" | "stub";

const MACH_O = ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"];

export function binKind(file: string): BinKind {
  let head: Buffer;
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(256);
      head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "stub";
  }
  if (head.subarray(0, 2).toString("latin1") === "MZ" || head.subarray(0, 4).toString("latin1") === "\x7fELF" || MACH_O.includes(head.subarray(0, 4).toString("hex"))) return "native";
  if (/\.(c|m)?js$/i.test(file)) return "node";
  return /^#!.*\bnode\b/.test(head.toString("utf8").split(/\r?\n/)[0] ?? "") ? "node" : "stub";
}

/** How to start a managed copy, or null when its bin is a placeholder. `dirs` join the agent's PATH, as a found CLI's do. */
export function managedLaunch(copy: ManagedCli, host: Pick<CliHost, "platform" | "env">, dirs: string[] = []): CliLaunch | null {
  const kind = binKind(copy.file);
  if (kind === "stub") return null;
  const p = host.platform === "win32" ? path.win32 : path.posix;
  const sep = host.platform === "win32" ? ";" : ":";
  return {
    file: copy.file,
    argv: (args) => (kind === "native" ? { command: copy.file, args } : { command: copy.runtime, args: [copy.file, ...args] }),
    env(base = host.env) {
      // Built-in Pi's own folder; the person's Pi signs in from ~/.pi like their own copy does.
      const rest = { ...base };
      delete rest.PI_CODING_AGENT_DIR;
      const key = Object.keys(rest).find((k) => k.toUpperCase() === "PATH") ?? (host.platform === "win32" ? "Path" : "PATH");
      // The person's own node stays first for the agent's tools; Tomrade's answers where there is none.
      const dirsNow = [p.dirname(copy.file), ...dirs, ...(rest[key] ?? "").split(sep).filter(Boolean), copy.nodeDir];
      return { ...rest, [key]: [...new Set(dirsNow)].join(sep), ...(kind === "node" ? { ELECTRON_RUN_AS_NODE: "1" } : {}), ...copy.env };
    }
  };
}
