import { useEffect, useState } from "react";
import type { Providing } from "@tomradex/community";
import type { QuickSetupResult } from "@tomradex/llm";
import { Icon } from "~/components/icons";
import { invoke, messageOf } from "~/lib/api";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useInstallProvider, useModelProviders, useProviderPlugins, useProviderSignIn, useQuickSetup, useProviders } from "~/lib/setup";
import { PlainSecretNote } from "~/components/ui/PlainSecretNote";
import { openExternal } from "~/lib/shell";
import { isCommitKey } from "~/lib/keys";

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

/** An official plugin that brings a provider, installed in one click. */
export function ProviderPluginOffer({ plugin, offer }: { plugin: Providing; offer: ReturnType<typeof useInstallProvider> }) {
  const { t } = useI18n();
  const busy = offer.busy === plugin.id;
  return (
    <div className="stack-2" data-testid="provider-plugin">
      <p className="meta-txt">{t("setup.pluginProvider", { title: plugin.title })}</p>
      <div className="row">
        <button type="button" className="btn btn-primary" data-testid="provider-plugin-install" disabled={!!offer.busy} aria-busy={busy} onClick={() => offer.install(plugin)}>
          {busy ? t("setup.installingProvider") : t("setup.installProvider", { title: plugin.title })}
        </button>
      </div>
      <ProviderInstallProblem plugin={plugin} offer={offer} />
    </div>
  );
}

/** Why a provider plugin did not get as far as a preset. */
export function ProviderInstallProblem({ plugin, offer }: { plugin: Providing; offer: ReturnType<typeof useInstallProvider> }) {
  const { t } = useI18n();
  if (offer.stalled?.id === plugin.id) return <p className="profile-problem" role="alert">{t("setup.providerNotReady", { title: plugin.title })}</p>;
  if (offer.failed?.id === plugin.id) return <p className="profile-problem" role="alert">{t("setup.installFailed", { title: plugin.title, message: messageOf(offer.failed.error) })}</p>;
  return null;
}

/**
 * One key to a working model: the key's shape picks the provider when it can,
 * and Tomrade checks the key and chooses a model itself. Every provider fact
 * comes from the llm plugin.
 */
export function QuickModelSetup({ onConnected }: { onConnected?: () => void }) {
  const { t } = useI18n();
  const providers = useProviders();
  const { data: kinds } = useModelProviders();
  const plugins = useProviderPlugins().data ?? [];
  const quick = useQuickSetup();
  const signIn = useProviderSignIn();
  const [key, setKey] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedPlugin, setPickedPlugin] = useState<string | null>(null);
  const [signInProblem, setSignInProblem] = useState<string | null>(null);
  const [guess, setGuess] = useState<string[]>([]);
  const [result, setResult] = useState<QuickSetupResult | null>(null);
  const offer = useInstallProvider((preset) => {
    setPickedPlugin(null);
    setPicked(preset.id);
    setResult(null);
  });

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
  const plugin = plugins.find((p) => p.id === pickedPlugin) ?? null;
  const signInTitle = kinds?.find((k) => k.id === chosen.provider)?.signIn;
  const connect = (apiKey = key) => {
    setResult(null);
    setSignInProblem(null);
    quick.mutate({ preset: chosen.id, ...(needsKey ? { apiKey } : {}) }, {
      onSuccess: (outcome) => {
        setResult(outcome);
        if (outcome.ok) {
          setKey("");
          onConnected?.();
        }
      },
      onError: (error) => setResult({ ok: false, kind: "other", detail: messageOf(error) })
    });
  };
  const signInAndConnect = () => {
    setResult(null);
    setSignInProblem(null);
    signIn.mutate(chosen.provider, {
      onSuccess: (outcome) => (outcome.ok ? connect(outcome.apiKey) : setSignInProblem(outcome.detail)),
      onError: (error) => setSignInProblem(messageOf(error))
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
            aria-checked={!plugin && p.id === chosen.id}
            className={!plugin && p.id === chosen.id ? "chip-opt sel" : "chip-opt"}
            data-provider={p.id}
            onClick={() => {
              setPicked(p.id);
              setPickedPlugin(null);
              setResult(null);
            }}
          >
            {p.title}
          </button>
        ))}
        {plugins.map((p) => (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={p.id === pickedPlugin}
            className={p.id === pickedPlugin ? "chip-opt sel" : "chip-opt"}
            data-plugin={p.id}
            title={t("setup.officialPlugin")}
            onClick={() => {
              setPickedPlugin(p.id);
              setResult(null);
            }}
          >
            <Icon name="i-plug" size={11} /> {p.title}
          </button>
        ))}
      </div>
      {plugin ? (
        <ProviderPluginOffer plugin={plugin} offer={offer} />
      ) : (
        <>
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
                  onKeyDown={(e) => isCommitKey(e) && key.trim() && !quick.isPending && connect()}
                />
                <button type="button" className="btn btn-primary" data-testid="quick-connect" disabled={!key.trim() || quick.isPending} aria-busy={quick.isPending} onClick={() => connect()}>
                  {quick.isPending ? t("setup.connecting") : t("setup.connect")}
                </button>
              </div>
              {signInTitle && (
                <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
                  <button type="button" className="btn btn-ghost" data-testid="quick-sign-in" disabled={signIn.isPending || quick.isPending} aria-busy={signIn.isPending} onClick={signInAndConnect}>
                    {signInTitle}
                  </button>
                  {signIn.isPending && <span className="meta-txt">{t("setup.signingIn")}</span>}
                </div>
              )}
              {signInProblem && <p className="profile-problem" role="alert">{t("setup.signInFailed", { message: signInProblem })}</p>}
              {!picked && guess.length === 1 && <span className="meta-txt">{t("setup.keyLooksLike", { provider: chosen.title })}</span>}
              <PlainSecretNote />
            </div>
          ) : (
            <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
              <span className="meta-txt" style={{ flex: 1 }}>{t("setup.localNoKey")}</span>
              <button type="button" className="btn btn-primary" data-testid="quick-connect" disabled={quick.isPending} aria-busy={quick.isPending} onClick={() => connect()}>
                {quick.isPending ? t("setup.connecting") : t("setup.connect")}
              </button>
            </div>
          )}
        </>
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
