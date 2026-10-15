import { useEffect, useRef, useState } from "react";
import type { EngineTry, EngineView } from "@tomradex/agent";
import { useQueryClient } from "@tanstack/react-query";
import { agentKeys } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useCurrentProject } from "./plugins/parts";

/**
 * One real turn on the engine, on request: does it answer? Readiness only
 * rules out what clearly cannot work; this is the person's way to be sure.
 * `command` is the CLI path setting — a change to it tries again once the
 * engine is ready.
 */
export function EngineTryRow({ engine, command }: { engine: EngineView; command?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const projectId = useCurrentProject();
  const [running, setRunning] = useState(false);
  const [last, setLast] = useState<EngineTry | null>(null);
  const shown = last ?? engine.tried ?? null;

  const run = async () => {
    setRunning(true);
    try {
      setLast(await invoke("agent.tryEngine", projectId ?? null, engine.id));
    } catch (error) {
      setLast({ ok: false, ms: 0, at: Date.now(), error: error instanceof Error ? error.message : String(error) });
    } finally {
      setRunning(false);
      void qc.invalidateQueries({ queryKey: agentKeys.engines });
    }
  };

  // A newly chosen CLI is tried as soon as it reads ready.
  const seen = useRef(command);
  const pending = useRef(false);
  useEffect(() => {
    if (command === seen.current) return;
    seen.current = command;
    pending.current = true;
    setLast(null);
  }, [command]);
  useEffect(() => {
    if (!pending.current || !engine.ok || running) return;
    pending.current = false;
    void run();
  }, [engine.ok, command, running]);

  return (
    <div className="eng-try meta-txt" data-testid={`engine-try-${engine.id}`}>
      <button type="button" className="btn btn-secondary" disabled={running || !engine.ok} onClick={() => void run()}>
        {running ? t("settingsDialog.engineTrying") : t("settingsDialog.engineTry")}
      </button>
      {!running && shown && (
        <span className={shown.ok ? "eng-try-ok" : "cli-warn"} role={shown.ok ? undefined : "alert"} data-testid="engine-try-result">
          {shown.ok
            ? t("settingsDialog.engineTryOk", { reply: shown.reply ?? "", seconds: (shown.ms / 1000).toFixed(1) })
            : t("settingsDialog.engineTryFailed", { error: shown.error ?? "" })}
        </span>
      )}
      {!running && !shown && <span>{t("settingsDialog.engineTryHint")}</span>}
      {!running && shown && !shown.ok && shown.details && (
        <details className="eng-try-details">
          <summary>{t("settingsDialog.engineTryDetails")}</summary>
          <pre>{shown.details}</pre>
        </details>
      )}
    </div>
  );
}
