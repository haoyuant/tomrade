import type { EngineView, LocalCliStatus } from "@tomradex/agent";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { agentKeys } from "./agent";
import { invoke } from "./api";
import type { MessageKey } from "./i18n";

/** What each local agent's CLI is called and how a person installs and signs in to it. */
export const LOCAL_AGENTS: Record<string, { name: string; install: (platform: string) => string[]; signIn: string; docs: string }> = {
  "claude-code": {
    name: "claude",
    // The official installer first; npm still works and is what many already have.
    install: (platform) => [platform === "win32" ? "irm https://claude.ai/install.ps1 | iex" : "curl -fsSL https://claude.ai/install.sh | bash", "npm install -g @anthropic-ai/claude-code"],
    signIn: "claude",
    docs: "https://docs.anthropic.com/en/docs/claude-code/setup"
  },
  codex: {
    name: "codex",
    install: () => ["npm install -g @openai/codex"],
    signIn: "codex login",
    docs: "https://github.com/openai/codex"
  }
};

export type EngineStatus = "ready" | "missing" | "broken" | "wsl" | "sign-in" | "service" | "other";

export function engineStatus(engine: EngineView): EngineStatus {
  if (engine.ok) return "ready";
  if (engine.cli?.wsl && engine.cli.state === "missing") return "wsl";
  if (engine.need === "install") return "missing";
  if (engine.need === "repair") return "broken";
  if (engine.need === "sign-in") return "sign-in";
  if (engine.need === "service") return "service";
  return "other";
}

const STATE_KEYS: Record<Exclude<EngineStatus, "ready" | "other">, MessageKey> = {
  missing: "localCli.stateMissing",
  broken: "localCli.stateBroken",
  wsl: "localCli.stateWsl",
  "sign-in": "localCli.stateSignIn",
  service: "localCli.stateService"
};

/** One short phrase for an engine's state, in the person's language — fits a select option or a row's end. */
export function engineStateLabel(engine: EngineView, t: (key: MessageKey, vars?: Record<string, string | number>) => string, unavailable: string): string {
  const status = engineStatus(engine);
  if (status === "ready") return engine.cli?.version ? t("localCli.stateReadyVersion", { version: engine.cli.version }) : t("localCli.stateReady");
  if (status === "other") return engine.reason ?? unavailable;
  return t(STATE_KEYS[status]);
}

/** Plain text for a bug report: what was looked at, in what order, and what each answered. */
export function cliDiagnostics(engine: EngineView, cli: LocalCliStatus, appVersion?: string): string {
  const lines = [
    `Tomrade ${appVersion ?? ""} · ${cli.platform} ${cli.arch}`.replace("  ", " "),
    `Engine: ${engine.title} (${engine.id}) — ${engine.ok ? "ready" : `not ready (${engine.need ?? "?"})`}`,
    `CLI: ${cli.name} — ${cli.state}${cli.path ? ` at ${cli.path} (${cli.source})` : ""}${cli.version ? `, version ${cli.version}` : ""}`,
    ...(cli.error ? [`Error: ${cli.error}`] : []),
    ...(cli.manual ? [`Chosen path: ${cli.manual.path} — ${cli.manual.error}`] : []),
    ...(cli.wsl ? [`Found in WSL: ${cli.wsl}`] : []),
    ...(!engine.ok && engine.reason ? [`Reason: ${engine.reason}`] : []),
    "",
    "Tried:",
    ...(cli.attempts.length ? cli.attempts.map((a) => `  [${a.source}] ${a.path} — ${a.ok ? "ok" : "failed"}: ${a.detail}`) : ["  (no candidate files found)"]),
    "",
    "Searched folders, in order:",
    ...cli.searched.map((dir) => `  ${dir}`),
    "",
    `PATH: ${cli.pathEnv}`
  ];
  return lines.join("\n");
}

/** Looks for every engine's CLI again, skipping the recent-probe shortcut, and shows what it found. */
export function useRecheckEngines() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => invoke("agent.engines", { fresh: true }),
    onSuccess: (views) => qc.setQueryData(agentKeys.engines, views)
  });
}
