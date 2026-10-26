import type { Context } from "cordis";
import type { EngineRecord } from "@tomradex/agent";
import { claudeRecord } from "@tomradex/engine-kit";

/** CodeBuddy writes Claude Code's transcripts under its own folders; read so while its plugin declares no record. */
const KNOWN: Record<string, EngineRecord> = { workbuddy: claudeRecord({ variable: "CODEBUDDY_CONFIG_DIR", dir: ".codebuddy" }) };

/** How an agent's own record of its sessions is read: as its engine says, else as Tomrade knows it; null when neither can. */
export function recordOf(ctx: Context, agent: string): EngineRecord | null {
  return ctx.get("agent")?.engineOf(agent)?.local?.record ?? KNOWN[agent] ?? null;
}

/** The command that takes an agent back into one of its conversations, by its session id; null for agents that cannot. */
export function resumeCommand(agent: string, sessionId: string | null): string | null {
  if (!sessionId || !/^[\w-]+$/.test(sessionId)) return null;
  if (agent === "claude-code") return `claude --resume ${sessionId}`;
  if (agent === "codex") return `codex resume ${sessionId}`;
  return null;
}
