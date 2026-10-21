import { useEffect, useRef, useState } from "react";
import { modelRefusal, providerMessage, type ModelErrorKind } from "@tomradex/domain";
import type { ModelProfile, ModelProviderView, ProviderView } from "@tomradex/llm";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { PlainSecretNote } from "~/components/ui/PlainSecretNote";
import { invoke } from "~/lib/api";
import { intlTag, useI18n, type MessageKey } from "~/lib/i18n";
import { openSettingsPane } from "~/lib/settingsHost";
import { useModelProviders, useProviderSignIn, useProviders } from "~/lib/setup";
import { openExternal } from "~/lib/shell";

const PROVIDER_TITLES: Record<string, MessageKey> = {
  "openai-compatible": "settingsDialog.providerOpenaiCompatible",
  anthropic: "settingsDialog.providerAnthropic",
  "openai-images": "agentPanel.imageApi"
};
// A profile whose provider is not installed still opens, as a plain compatible endpoint.
const UNKNOWN_PROVIDER: Omit<ModelProviderView, "id" | "title"> = { keyRequired: false, baseURL: { default: "", editable: true }, chat: true, defaultInput: [] };
export const providerOf = (kinds: ModelProviderView[] | undefined, id: string): ModelProviderView => kinds?.find((k) => k.id === id) ?? { id, title: id, ...UNKNOWN_PROVIDER };

export const CUSTOM_PICK = "__custom__";

const hostOf = (address: string): string => {
  try {
    return new URL(address).host;
  } catch {
    return address;
  }
};

/** Where a well-known service hands out keys, by the host a profile for it talks to. */
const keyPageFor = (host: string, presets: ProviderView[] | undefined, kinds: ModelProviderView[] | undefined): string | undefined =>
  presets?.find((p) => p.keyPage && hostOf(p.baseURL || providerOf(kinds, p.provider).baseURL.default) === host)?.keyPage;

/** The endpoint's own listing, refetched once typing settles: a key or address mid-edit asks nothing. */
function useModelListing(endpoint: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">, keyRequired: boolean) {
  const [settled, setSettled] = useState(endpoint);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(endpoint), 600);
    return () => clearTimeout(timer);
  }, [endpoint.provider, endpoint.baseURL, endpoint.apiKey]);
  const { provider, baseURL, apiKey } = settled;
  return useQuery({
    queryKey: ["llm.models", provider, baseURL ?? "", apiKey],
    queryFn: () => invoke("llm.models", { provider, baseURL, apiKey }),
    enabled: !keyRequired || apiKey.trim().length > 0,
    staleTime: 5 * 60_000,
    retry: false
  });
}

// Listings do not say what a key's tier may use: a model the check refused leaves that key's picker until restart.
const REFUSED_MODELS = ["llm", "refusedModels"] as const;
type RefusedModels = Record<string, string[]>;
const endpointOf = (p: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">) => JSON.stringify([p.provider, p.baseURL ?? "", p.apiKey.trim()]);
/** Kept in the query cache, never collected or refetched away, so it outlives the dialog as the module Map did. */
function useRefusedModels() {
  const qc = useQueryClient();
  const all = useQuery<RefusedModels>({
    queryKey: REFUSED_MODELS,
    queryFn: () => qc.getQueryData<RefusedModels>(REFUSED_MODELS) ?? {},
    initialData: {},
    staleTime: Infinity,
    gcTime: Infinity
  }).data;
  const refuse = (p: ModelProfile) =>
    qc.setQueryData<RefusedModels>(REFUSED_MODELS, (prev = {}) => ({ ...prev, [endpointOf(p)]: [...new Set([...(prev[endpointOf(p)] ?? []), p.model])] }));
  return { refusedFor: (p: Pick<ModelProfile, "provider" | "baseURL" | "apiKey">) => new Set(all[endpointOf(p)]), refuse };
}

const sameModes = (detected: string[], stored: string[] | undefined) => !!stored && detected.length === stored.length && detected.every((m) => stored.includes(m));

/**
 * The model, picked from what the endpoint lists; typed in when it lists nothing or the model is not listed.
 * Picking a model also takes the media Tomrade detected for it; an undetected model falls back to the provider's default.
 */
function ModelPickField({ draft, host, keyRequired, onChange, onPicked }: { draft: ModelProfile; host: string; keyRequired: boolean; onChange: (patch: Partial<ModelProfile>) => void; onPicked: (model: string) => void }) {
  const { t } = useI18n();
  const listing = useModelListing(draft, keyRequired);
  const refused = useRefusedModels().refusedFor(draft);
  const models = listing.data?.ok ? listing.data.models.filter((id) => !refused.has(id)) : [];
  const detected = (model: string) => (listing.data?.ok ? listing.data.capabilities[model] : undefined);
  const pick = (model: string) => onChange({ model, ...(detected(model) ?? { inputModalities: undefined, outputModalities: undefined }) });
  // A profile saved with hand-ticked media takes what the listing now says once it answers.
  const found = detected(draft.model);
  useEffect(() => {
    if (found && !(sameModes(found.inputModalities, draft.inputModalities) && sameModes(found.outputModalities, draft.outputModalities))) onChange(found);
  }, [found, draft.model]);
  const [custom, setCustom] = useState(false);
  const typed = custom || models.length === 0 || (draft.model !== "" && !models.includes(draft.model));
  const status = listing.isFetching
    ? t("settingsDialog.modelListLoading", { host })
    : !listing.isEnabled || (listing.data && !listing.data.ok && listing.data.kind === "auth" && !draft.apiKey.trim())
      ? t("settingsDialog.modelListNeedsKey", { host })
      : listing.data && !listing.data.ok
        ? t("settingsDialog.modelListFailed", { host })
        : listing.data?.ok && models.length === 0
          ? t("settingsDialog.modelListNone", { host })
          : null;
  return (
    <div className="field">
      <label htmlFor="pfModel">{t("settingsDialog.modelLabel")}</label>
      {models.length > 0 && (
        <select
          id={typed ? "pfModelPick" : "pfModel"}
          className="input num"
          value={typed ? CUSTOM_PICK : draft.model}
          onChange={(e) => {
            const other = e.target.value === CUSTOM_PICK;
            setCustom(other);
            if (!other) {
              pick(e.target.value);
              onPicked(e.target.value);
            }
          }}
        >
          {draft.model === "" && !custom && <option value="" disabled>{t("settingsDialog.modelPickPlaceholder")}</option>}
          {models.map((id) => (
            <option key={id} value={id}>{id}</option>
          ))}
          <option value={CUSTOM_PICK}>{t("settingsDialog.modelPickOther")}</option>
        </select>
      )}
      {typed && <input id="pfModel" className="input num" value={draft.model} onChange={(e) => pick(e.target.value)} />}
      {status && (
        <span className="meta-txt">
          {status}
          {listing.data && !listing.data.ok && !listing.isFetching && (
            <>
              {" "}
              <button type="button" className="link-inline" onClick={() => void listing.refetch()}>
                {t("settingsDialog.modelListRefresh")}
              </button>
            </>
          )}
        </span>
      )}
    </div>
  );
}

/** Which way web search goes now: the models that search on their own, and the service that searches for the rest. */
export function SearchRouteLine({ profiles }: { profiles: ModelProfile[] }) {
  const { t, locale } = useI18n();
  // asked again whenever a profile changes: a key can bring or take a search service
  const { data: route } = useQuery({ queryKey: ["llm", "searchRoute", JSON.stringify(profiles)], queryFn: () => invoke("llm.searchRoute"), staleTime: 15_000 });
  if (!route) return null;
  const models = new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(route.native);
  const everyone = route.native.length >= profiles.length;
  const line = everyone
    ? t("settingsDialog.searchAllNative")
    : route.native.length
      ? route.service ? t("settingsDialog.searchNativeThenService", { models, service: route.service }) : t("settingsDialog.searchNativeOnly", { models })
      : route.service ? t("settingsDialog.searchService", { service: route.service }) : t("settingsDialog.searchNone");
  return (
    <p className="meta-txt" data-testid="search-route">
      {line}
      {!everyone && !route.service && (
        <>
          {" "}
          <button type="button" className="link-inline" onClick={() => openSettingsPane("plugins")}>
            {t("settingsDialog.searchSetUp")}
          </button>
        </>
      )}
    </p>
  );
}

/** What the model reads and makes, as Tomrade detected it: read-only, so nobody ticks media from memory. */
function ModelMediaLine({ draft, host, defaultInput }: { draft: ModelProfile; host: string; defaultInput: string[] }) {
  const { t, locale } = useI18n();
  const list = (items: string[]) => new Intl.ListFormat(intlTag(locale), { type: "conjunction" }).format(items);
  // the adapters' own defaults when nothing was detected
  const input = draft.inputModalities ?? defaultInput;
  const output = draft.outputModalities ?? [];
  const reads = t("settingsDialog.modelMediaReads", { list: list(["text", ...input].map((m) => t(`settingsDialog.modelMedia_${m}` as MessageKey))) });
  const makes = output.length ? ` ${t("settingsDialog.modelMediaMakes", { list: list(output.map((m) => t(`settingsDialog.modelMedia_${m}` as MessageKey))) })}` : "";
  return (
    <div className="field">
      <label htmlFor="pfMedia">{t("settingsDialog.modelMediaLabel")}</label>
      <output id="pfMedia">{reads}{makes}</output>
      <span className="meta-txt">{t("settingsDialog.modelMediaNote", { host })}</span>
    </div>
  );
}

export function ProfileForm({ profile, onSave, onCancel }: { profile: ModelProfile; onSave: (p: ModelProfile) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<ModelProfile>(profile);
  const refuseModel = useRefusedModels().refuse;
  const [checking, setChecking] = useState(false);
  const [problem, setProblem] = useState<{ kind: ModelErrorKind; detail: string } | null>(null);
  // a check's answer counts only while nothing was edited after it was asked
  const asked = useRef(0);
  const set = (patch: Partial<ModelProfile>) => {
    asked.current += 1;
    setProblem(null);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const { data: kinds } = useModelProviders();
  const { data: presets } = useProviders();
  const signIn = useProviderSignIn();
  const kind = providerOf(kinds, draft.provider);
  const valid = draft.model.trim().length > 0 && (!kind.keyRequired || draft.apiKey.trim().length > 0);
  const host = hostOf(draft.baseURL || kind.baseURL.default);
  const keyPage = keyPageFor(host, presets, kinds);
  const candidate = (): ModelProfile => ({ ...draft, title: draft.title || draft.model });
  // A wrong key or address shows here, at save, not in the first conversation. A rate limit means the key works.
  const checkAndSave = async () => {
    asked.current += 1;
    setChecking(true);
    setProblem(null);
    try {
      const result = await invoke("llm.test", candidate());
      if (result.ok || result.kind === "rate") onSave(candidate());
      else {
        if (result.kind === "model") refuseModel(draft);
        setProblem(result);
      }
    } catch {
      onSave(candidate());
    } finally {
      setChecking(false);
    }
  };
  // A picked model is checked at once: a key's tier or the model's API shows here, before save.
  const tryModel = async (model: string) => {
    const run = ++asked.current;
    const tried = { ...candidate(), model };
    const result = await invoke("llm.test", tried).catch(() => null);
    if (run !== asked.current || !result || result.ok || result.kind === "rate") return;
    if (result.kind === "model") refuseModel(tried);
    setProblem(result);
  };
  const refusal = problem?.kind === "model" ? modelRefusal(problem.detail) : null;
  const said = problem?.kind === "model" ? providerMessage(problem.detail) : null;
  return (
    <div className="panel stack-3" style={{ background: "var(--bg)" }}>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="pfTitle">{t("settingsDialog.profileNameLabel")}</label>
          <input id="pfTitle" className="input" value={draft.title} placeholder={draft.model || t("settingsDialog.myModelPlaceholder")} onChange={(e) => set({ title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="pfProvider">{t("settingsDialog.profileProviderLabel")}</label>
          <select id="pfProvider" className="input" value={draft.provider} onChange={(e) => set({ provider: e.target.value })}>
            {(kinds?.some((k) => k.id === draft.provider) ? kinds : [...(kinds ?? []), kind]).map((k) => (
              <option key={k.id} value={k.id}>{PROVIDER_TITLES[k.id] ? t(PROVIDER_TITLES[k.id]) : k.title}</option>
            ))}
          </select>
        </div>
      </div>
      {kind.baseURL.editable && (
        <div className="field">
          <label htmlFor="pfBase">{t("settingsDialog.baseUrlLabel")}</label>
          <input id="pfBase" className="input num" value={draft.baseURL ?? ""} onChange={(e) => set({ baseURL: e.target.value })} />
        </div>
      )}
      <div className="field">
        <label htmlFor="pfKey">{t("settingsDialog.apiKeyLabel")}</label>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <input id="pfKey" className="input num" style={{ flex: 1 }} type="password" value={draft.apiKey} onChange={(e) => set({ apiKey: e.target.value })} />
          {kind.signIn && (
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="profile-sign-in"
              disabled={signIn.isPending}
              aria-busy={signIn.isPending}
              onClick={() =>
                signIn.mutate(draft.provider, { onSuccess: (outcome) => outcome.ok && set({ apiKey: outcome.apiKey }) })
              }
            >
              {signIn.isPending ? t("setup.signingIn") : kind.signIn}
            </button>
          )}
        </div>
        {signIn.data && !signIn.data.ok && <p className="profile-problem" role="alert">{t("setup.signInFailed", { message: signIn.data.detail })}</p>}
        <PlainSecretNote />
        <span className="meta-txt">
          {t("settingsDialog.localEndpointNote")}
          {keyPage && (
            <>
              {" "}
              <button type="button" className="link-inline" onClick={() => openExternal(keyPage)}>
                {t("settingsDialog.getApiKey", { host })}
              </button>
            </>
          )}
        </span>
      </div>
      <ModelPickField draft={draft} host={host || t("settingsDialog.theEndpoint")} keyRequired={kind.keyRequired} onChange={set} onPicked={(model) => void tryModel(model)} />
      {kind.chat && <ModelMediaLine draft={draft} host={host || t("settingsDialog.theEndpoint")} defaultInput={kind.defaultInput} />}
      {problem && (
        <div className="profile-problem" role="alert">
          <p>{t(refusal === "method" ? "settingsDialog.profileCheck_modelMethod" : refusal === "tier" ? "settingsDialog.profileCheck_modelTier" : (`settingsDialog.profileCheck_${problem.kind}` as MessageKey), { host: host || t("settingsDialog.theEndpoint"), model: draft.model })}</p>
          {said && <p className="meta-txt">{t("settingsDialog.profileCheckSaid", { host: host || t("settingsDialog.theEndpoint"), message: said })}</p>}
          <details className="ai-error-details">
            <summary>{t("agentPanel.errorDetails")}</summary>
            <code>{problem.detail}</code>
          </details>
        </div>
      )}
      {/* At the foot, primary: users looked for a way out and hit the row's Remove instead. */}
      <div className="row" style={{ gap: 8, justifyContent: "flex-end", borderTop: "1px solid var(--border-soft)", paddingTop: "var(--space-3)" }}>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
        {problem && (
          <button type="button" className="btn btn-ghost" onClick={() => onSave(candidate())}>
            {t("settingsDialog.profileSaveAnyway")}
          </button>
        )}
        <button type="button" className="btn btn-primary" disabled={!valid || checking} aria-busy={checking} onClick={() => void checkAndSave()}>
          {checking ? t("settingsDialog.profileChecking") : t("settingsDialog.saveProfile")}
        </button>
      </div>
    </div>
  );
}
