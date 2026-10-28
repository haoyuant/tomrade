import { compileManifest, type AgentManifest, type CompiledManifest } from "./detection.js";
import { MANIFESTS } from "./manifests.js";
import { TOMRADE_MANIFESTS } from "./manifests-tomrade.js";

/*
 * Reading an agent off its pane's screen, with nothing native to load: the pty host reads its own panes with it on
 * Windows, and the herdr service reads with it the panes of agents herdr has no manifest for.
 */

export { detect, type CompiledManifest, type Detection, type DetectionInput } from "./detection.js";

const compiled = new Map<string, CompiledManifest | null>();

const named = (m: AgentManifest, agent: string) => m.id === agent || !!m.aliases?.includes(agent);

/** The manifest for an agent, by its id or an alias: herdr's, else Tomrade's own; null for none, or one this engine cannot read. */
export function manifestOf(agent: string, log?: (line: string) => void): CompiledManifest | null {
  if (!compiled.has(agent)) {
    const manifest = Object.values(MANIFESTS).find((m) => named(m, agent)) ?? Object.values(TOMRADE_MANIFESTS).find((m) => named(m, agent));
    let ready: CompiledManifest | null = null;
    try {
      ready = manifest ? compileManifest(manifest) : null;
    } catch (err) {
      log?.(`the ${agent} detection manifest does not compile: ${err instanceof Error ? err.message : String(err)}`);
    }
    compiled.set(agent, ready);
  }
  return compiled.get(agent)!;
}

/** Whether Tomrade reads this agent itself, herdr having no manifest for it. */
export const ownManifest = (agent: string): boolean => !Object.values(MANIFESTS).some((m) => named(m, agent)) && Object.values(TOMRADE_MANIFESTS).some((m) => named(m, agent));

/** The commands of the agents only Tomrade's manifests read, as a foreground process names them. */
const OWN_COMMANDS: Record<string, string> = { codebuddy: "codebuddy" };
const RUNNERS = new Set(["node", "bun"]);
const base = (word: string) => word.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|js|mjs)$/, "");

/** Which of those agents a foreground command line runs, itself or as a script Node or Bun runs; null for anything else. */
export function ownAgentOfCommand(cmdline: string | undefined): string | null {
  const words = cmdline?.trim().split(/\s+/) ?? [];
  if (!words.length) return null;
  const first = base(words[0]!);
  const program = RUNNERS.has(first) ? base(words.find((w, i) => i > 0 && !w.startsWith("-")) ?? "") : first;
  return Object.entries(OWN_COMMANDS).find(([, command]) => command === program)?.[0] ?? null;
}
