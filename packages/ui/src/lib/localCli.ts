import type { EngineView, LocalCliStatus } from "@tomradex/agent";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invoke } from "./api";
import { failedTry } from "./engines";
import type { MessageKey } from "./i18n";
import { keys } from "./queries/keys";

export type EngineStatus = "ready" | "missing" | "desktop-only" | "broken" | "wsl" | "sign-in" | "service" | "model" | "other";

export function engineStatus(engine: EngineView): EngineStatus {
  if (engine.ok) return "ready";
  if (engine.cli?.wsl && engine.cli.state === "missing") return "wsl";
  if (engine.cli?.desktopApp && engine.cli.state === "missing") return "desktop-only";
  if (engine.need === "install") return "missing";
  if (engine.need === "repair") return "broken";
  if (engine.need === "sign-in") return "sign-in";
  if (engine.need === "model") return "model";
  // "service" names the MCP server only for a local agent; any other engine says which service itself.
  if (engine.need === "service" && engine.cli) return "service";
  return "other";
}

const STATE_KEYS: Record<Exclude<EngineStatus, "ready" | "other">, MessageKey> = {
  missing: "localCli.stateMissing",
  "desktop-only": "localCli.stateDesktopOnly",
  broken: "localCli.stateBroken",
  wsl: "localCli.stateWsl",
  "sign-in": "localCli.stateSignIn",
  service: "localCli.stateService",
  model: "localCli.stateModel"
};

/** One short phrase for an engine's state, in the person's language — fits a select option or a row's end. */
export function engineStateLabel(engine: EngineView, t: (key: MessageKey, vars?: Record<string, string | number>) => string, unavailable: string): string {
  const status = engineStatus(engine);
  if (status === "ready") {
    // Found and signed in is not ready: the test message with these settings must have answered.
    const failed = failedTry(engine);
    if (failed) return t("localCli.stateTestFailed", { error: brief(failed.error ?? t("localCli.stateNoReply")) });
    return engine.cli?.version ? t("localCli.stateReadyVersion", { version: engine.cli.version }) : t("localCli.stateReady");
  }
  if (status === "other") return engine.reason ?? unavailable;
  return t(STATE_KEYS[status]);
}

/** An error long enough to break a row, cut where it still names the failure. */
const brief = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}…` : text);

/** Plain text for a bug report: what was looked at, in what order, and what each answered. */
export function cliDiagnostics(engine: EngineView, cli: LocalCliStatus, appVersion?: string): string {
  const lines = [
    `Tomrade ${appVersion ?? ""} · ${cli.platform} ${cli.arch}`.replace("  ", " "),
    `Engine: ${engine.title} (${engine.id}) — ${engine.ok ? "ready" : `not ready (${engine.need ?? "?"})`}`,
    `CLI: ${cli.name} — ${cli.state}${cli.path ? ` at ${cli.path} (${cli.source})` : ""}${cli.version ? `, version ${cli.version}` : ""}`,
    ...(cli.error ? [`Error: ${cli.error}`] : []),
    ...(cli.manual ? [`Chosen path: ${cli.manual.path} — ${cli.manual.error}`] : []),
    ...(cli.wsl ? [`Found in WSL: ${cli.wsl}`] : []),
    ...(cli.shellTimedOut ? [`Login shell: ${cli.shellTimedOut} did not answer in time`] : []),
    ...(!engine.ok && engine.reason ? [`Reason: ${engine.reason}`] : []),
    ...(engine.configDir ? [`Config folder: ${engine.configDir}`] : []),
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
    onSuccess: (views) => qc.setQueryData(keys.agent.engines, views)
  });
}
