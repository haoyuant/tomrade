import os from "node:os";
import path from "node:path";
import type { Context } from "cordis";
import { z } from "zod";
import type { Engine, EngineStepLimit } from "@tomradex/agent";
import { localAvailability, localCli } from "@tomradex/engine-kit";
import { claudeSignedIn } from "./cli.js";
import { claudeMcpLink } from "./mcp-link.js";

const MAX_TURNS: EngineStepLimit = { key: "maxTurns", min: 1, max: 200, default: 24 };

// Unknown keys are dropped, so a saved `transport` from older versions is ignored.
export const ClaudeCodeOptions = z.object({
  command: z.string().default("claude"),
  /** Passed as --model; empty = whatever the user's Claude Code is configured with. */
  model: z.string().optional(),
  /** Passed as --effort; the CLI validates the level, so new levels need no release here. */
  effort: z.string().optional(),
  maxTurns: z.number().int().min(MAX_TURNS.min).max(MAX_TURNS.max).default(MAX_TURNS.default),
  maxBudgetUsd: z.number().positive().optional(),
  /** Claude Code's own tools to allow besides the tomrade MCP tools (e.g. "WebSearch", "Read", "Bash"). */
  allowTools: z.array(z.string()).default([]),
  /** Optional coding turn ceiling; omitted uses the local agent's unlimited default. */
  codeMaxTurns: z.number().int().min(1).optional(),
  /** …and its own permission mode, in a worktree of its own. The user's settings.json allow-rules still apply. */
  codePermissionMode: z.enum(["acceptEdits", "bypassPermissions", "dontAsk", "default", "auto", "plan"]).optional()
});
export type ClaudeCodeOptions = z.infer<typeof ClaudeCodeOptions>;

/** Why Claude Code is sending a request again (its `api_retry` message), in a few words. */
export function retryReason(message: { error_status: number | null; error: string; no_response?: { waited_ms: number } }): string {
  if (message.no_response) return `no response in ${Math.round(message.no_response.waited_ms / 1000)}s`;
  if (message.error_status === null) return "connection dropped";
  return `${message.error.replace(/_/g, " ")} (HTTP ${message.error_status})`;
}

/** Everything about the Claude Code engine except how a turn runs: identity, options, availability, setup. */
export function claudeCodeEngineInfo(ctx: Context): Omit<Engine, "turn"> {
  const cli = localCli("claude");
  return {
    id: "claude-code",
    title: "Claude Code",
    author: "ai:claude-code",
    capabilities: ["backlog", "code", "general"],
    options: ClaudeCodeOptions,
    stepLimit: MAX_TURNS,
    available: localAvailability(ctx, {
      engineId: "claude-code",
      title: "Claude Code",
      cli,
      install: "install Claude Code and sign in",
      // The Claude desktop app has no `claude` command.
      desktopApp: { title: "Claude", mac: ["Claude"], windows: ["AnthropicClaude"] },
      signIn: { args: ["auth", "status"], says: claudeSignedIn, reason: "Claude Code is not signed in — run `claude` in a terminal and log in" },
      configDir: () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")
    }),
    local: {
      picks: () => [
        // aliases the CLI resolves itself, so they don't go stale with releases
        { key: "model", title: "Model", choices: [{ value: "sonnet" }, { value: "opus" }, { value: "haiku" }], freeText: true },
        { key: "effort", title: "Effort", choices: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }, { value: "max" }] }
      ],
      checkCli: (file) => cli.check(file),
      mcpLink: claudeMcpLink(ctx, cli),
      setup: {
        // The official installer first; npm still works and is what many already have.
        install: [process.platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", "npm install -g @anthropic-ai/claude-code"],
        // The same order for the installs Tomrade runs itself: the official script (no admin, ~/.local), then npm — the system's, or the app's borrowed one.
        installers: [
          { kind: "script", url: "https://claude.ai/install.sh", shell: "sh" },
          { kind: "script", url: "https://claude.ai/install.ps1", shell: "powershell" },
          { kind: "npm", package: "@anthropic-ai/claude-code" }
        ],
        // The terminal way, for a CLI too old to have `claude auth login`.
        signIn: "claude",
        signInRuns: true,
        // `claude auth login` opens the browser itself and returns once signed in; nothing to type.
        signInRun: { args: ["auth", "login"] },
        docs: "https://docs.anthropic.com/en/docs/claude-code/setup",
        download: "https://code.claude.com/docs/en/setup",
        desktop: { title: "Claude", shipsCli: false },
        suggested: true
      }
    }
  };
}
