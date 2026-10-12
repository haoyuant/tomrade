import { useEffect, useState } from "react";
import type { QuickSetupResult } from "@tomradex/llm";
import { Icon } from "~/components/icons";
import { invoke } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useQuickSetup, useProviders } from "~/lib/setup";
import { openExternal } from "~/lib/shell";

/** Why a connection failed, in words that say what to fix. */
export function SetupProblem({ result, provider }: { result: Extract<QuickSetupResult, { ok: false }>; provider: string }) {
  const { t } = useI18n();
  return (
    <div className="profile-problem" role="alert" data-testid="setup-problem">
      <p>{result.kind === "model" ? t("setup.noModel", { provider }) : t(`settingsDialog.profileCheck_${result.kind}` as MessageKey, { host: provider, model: "" })}</p>
      <details className="ai-error-details">
        <summary>{t("agentPanel.errorDetails")}</summary>
        <code>{result.detail}</code>
      </details>
    </div>
  );
}

/**
 * One key to a working model: the key's shape picks the provider when it can,
 * and Tomrade checks the key and chooses a model itself. Every provider fact
 * comes from the llm plugin.
 */
export function QuickModelSetup({ onConnected }: { onConnected?: () => void }) {
  const { t } = useI18n();
  const providers = useProviders();
  const quick = useQuickSetup();
  const [key, setKey] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [guess, setGuess] = useState<string[]>([]);
  const [result, setResult] = useState<QuickSetupResult | null>(null);

  useEffect(() => {
    const value = key.trim();
    if (!value) return setGuess([]);
    let live = true;
    void invoke("llm.guess", value).then((ids) => live && setGuess(ids));
    return () => {
      live = false;
    };
  }, [key]);

  const list = providers.data ?? [];
  const chosen = list.find((p) => p.id === (picked ?? guess[0])) ?? list[0];
  if (!chosen) return null;
  const needsKey = !chosen.local;
  const connect = () => {
    setResult(null);
    quick.mutate({ preset: chosen.id, ...(needsKey ? { apiKey: key } : {}) }, {
      onSuccess: (outcome) => {
        setResult(outcome);
        if (outcome.ok) {
          setKey("");
          onConnected?.();
        }
      },
      onError: (error) => setResult({ ok: false, kind: "other", detail: error instanceof Error ? error.message : String(error) })
    });
  };

  return (
    <div className="quick-model stack-3" data-testid="quick-model">
      <div className="quick-providers" role="radiogroup" aria-label={t("setup.providerLabel")}>
        {list.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === chosen.id}
            className={p.id === chosen.id ? "chip-opt sel" : "chip-opt"}
            data-provider={p.id}
            onClick={() => {
              setPicked(p.id);
              setResult(null);
            }}
          >
            {p.title}
          </button>
        ))}
      </div>
      <p className="meta-txt">
        {chosen.hint}
        {chosen.keyPage && (
          <>
            {" · "}
            <button type="button" className="link-inline" onClick={() => openExternal(chosen.keyPage!)}>
              {t("setup.getKey", { provider: chosen.title })}
            </button>
          </>
        )}
      </p>
      {needsKey ? (
        <div className="field">
          <label htmlFor="quickKey">{t("setup.keyLabel")}</label>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input
              id="quickKey"
              className="input num"
              style={{ flex: 1 }}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={t("setup.keyPlaceholder")}
              value={key}
              onChange={(e) => {
                setKey(e.target.value);
                setResult(null);
              }}
              onKeyDown={(e) => e.key === "Enter" && key.trim() && !quick.isPending && connect()}
            />
            <button type="button" className="btn btn-primary" data-testid="quick-connect" disabled={!key.trim() || quick.isPending} aria-busy={quick.isPending} onClick={connect}>
              {quick.isPending ? t("setup.connecting") : t("setup.connect")}
            </button>
          </div>
          {!picked && guess.length === 1 && <span className="meta-txt">{t("setup.keyLooksLike", { provider: chosen.title })}</span>}
        </div>
      ) : (
        <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
          <span className="meta-txt" style={{ flex: 1 }}>{t("setup.localNoKey")}</span>
          <button type="button" className="btn btn-primary" data-testid="quick-connect" disabled={quick.isPending} aria-busy={quick.isPending} onClick={connect}>
            {quick.isPending ? t("setup.connecting") : t("setup.connect")}
          </button>
        </div>
      )}
      {result && !result.ok && <SetupProblem result={result} provider={chosen.title} />}
      {result?.ok && (
        <p className="setup-ok" data-testid="quick-connected">
          <Icon name="i-check" size={13} /> {t("setup.connected", { title: result.profile.title, model: result.profile.model })}
        </p>
      )}
    </div>
  );
}
