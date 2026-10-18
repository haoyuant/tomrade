import { useState } from "react";
import type { StorageProviderView, SyncState } from "@tomradex/storage";
import { useQueryClient } from "@tanstack/react-query";
import { Icon } from "~/components/icons";
import { ConnectionPanel, DestinationPicker, message } from "~/components/projects/destination";
import { Eyebrow, SectionHead, Tag } from "~/components/ui/atoms";
import { SchemaField, defaultsOf, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useAttachAll, useBindHub, useCacheDir, useHubInfo, useHubRemote, useOverwriteCatalog, useRestores, useStorageConnection, useStorageProviders, useSyncHub, useUnbindHub } from "~/lib/queries";
import { reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { RestoreRow } from "~/components/projects/RestoreCards";
import { AccountPanel } from "./AccountPanel";

/** The same words the project block uses for the same states. */
function stateOf(t: (key: MessageKey) => string): Record<SyncState, { label: string; tone: "faint" | "neutral" | "strong"; warn?: boolean }> {
  return {
    local: { label: t("storageBlock.stateLocalLabel"), tone: "neutral" },
    synced: { label: t("storageBlock.stateSyncedLabel"), tone: "faint" },
    ahead: { label: t("storageBlock.stateAheadLabel"), tone: "neutral" },
    behind: { label: t("storageBlock.stateBehindLabel"), tone: "neutral" },
    diverged: { label: t("storageBlock.stateDivergedLabel"), tone: "strong", warn: true },
    syncing: { label: t("storageBlock.stateSyncingLabel"), tone: "neutral" },
    offline: { label: t("storageBlock.stateOfflineLabel"), tone: "strong", warn: true },
    error: { label: t("storageBlock.stateErrorLabel"), tone: "strong", warn: true },
    unavailable: { label: t("storageBlock.stateUnavailableLabel"), tone: "strong", warn: true }
  };
}

/**
 * Where everything lives. The Hub is the person's folder: give it a remote and
 * another machine becomes this one. Its catalog names every project it knows;
 * what is missing here is restored by itself, and each row says how far along
 * it is. The cache under it is named too, as the one thing safe to delete.
 */
export function HubPane() {
  const { t, tx } = useI18n();
  const qc = useQueryClient();
  const STATE = stateOf(t);
  const hub = useHubInfo();
  const cacheDir = useCacheDir();
  const remote = useHubRemote();
  const restores = useRestores();
  const providers = useStorageProviders();
  const sync = useSyncHub();
  const attachAll = useAttachAll();
  const overwrite = useOverwriteCatalog();
  const toast = useToast();
  const dir = hub.data?.dir ?? null;
  // With an account, projects get a folder of their own on this machine; the Hub itself is in Supabase.
  const cloud = !!hub.data?.cloudEnabled;
  const folder = (cloud ? hub.data?.projectsDir : dir) ?? null;
  const status = remote.data?.status;
  const state = STATE[status?.state ?? "local"];
  const busy = sync.isPending || attachAll.isPending;
  const missing = restores.data?.entries ?? [];
  const catalogProblem = hub.data?.catalogProblem ?? null;

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) => toast({ body: <>{tx("hubPane.syncedToast", { label: STATE[next.state].label, location: <span className="num">{next.location ?? ""}</span> })}</> }),
      onError: (error) => toast({ body: message(error) })
    });

  const overwriteCatalog = () =>
    overwrite.mutate(undefined, {
      onSuccess: () => toast({ body: t("hubPane.catalogOverwrittenToast") }),
      onError: (error) => toast({ body: message(error) })
    });

  const retryAll = () =>
    attachAll.mutate(undefined, {
      onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] }),
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <>
      <SectionHead title={t("hubPane.title")}>{t(hub.data?.cloudEnabled ? "hubPane.cloudLede" : "hubPane.lede")}</SectionHead>
      {catalogProblem && (
        <div className="panel stack-2 hub-catalog-problem" style={{ marginBottom: "var(--space-3)" }}>
          <div className="cfg-row">
            <Icon name="i-warn" size={15} style={{ color: "var(--danger)" }} />
            <span className="cfg-name">{t("hubPane.catalogProblemTitle")}</span>
          </div>
          <p className="meta-txt dense">
            {tx("hubPane.catalogProblemNote", {
              reason: catalogProblem.dropped
                ? t("hubPane.catalogEntriesDropped", { count: catalogProblem.dropped.count, of: catalogProblem.dropped.of, detail: catalogProblem.detail })
                : t("hubPane.catalogNotJson", { detail: catalogProblem.detail }),
              keptAs: <span className="num">{catalogProblem.keptAs}</span>
            })}
          </p>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button type="button" className="btn btn-secondary hub-catalog-overwrite" disabled={overwrite.isPending} onClick={overwriteCatalog}>
              {overwrite.isPending ? t("hubPane.catalogOverwriting") : t("hubPane.catalogOverwrite")}
            </button>
          </div>
        </div>
      )}
      <div className="panel stack-3 hub-pane">
        <div className="field">
          <label htmlFor="hubDir">{t(cloud ? "settingsDialog.projectsDirLabel" : "hubPane.folderLabel")}</label>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input id="hubDir" className="input num" style={{ flex: 1 }} readOnly value={folder ?? ""} />
            {folder && (
              <button type="button" className="btn btn-ghost" onClick={() => reveal(folder)}>
                {t("hubPane.reveal")}
              </button>
            )}
          </div>
          <span className="meta-txt">{t(cloud ? "settingsDialog.projectsDirNote" : "hubPane.folderNote")}</span>
        </div>
        <div className="field">
          <label htmlFor="hubCache">{t("settingsDialog.cacheDirLabel")}</label>
          <input id="hubCache" className="input num" readOnly value={cacheDir.data ?? ""} />
          <span className="meta-txt">{t("settingsDialog.cacheDirNote")}</span>
        </div>
      </div>

      {hub.data?.cloudEnabled ? <AccountPanel /> : <HubRemoteSection bound={remote.data?.remote ?? null} location={status?.location ?? null} disabled={busy || !dir} providers={providers.data ?? []} />}

      {(remote.data?.remote || status?.state === "error") && (
        <div style={{ marginTop: "var(--space-4)" }}>
          <Eyebrow>{t("hubPane.stateLabel")}</Eyebrow>
          <div className="cfg-row hub-status" style={{ marginTop: "var(--space-2)" }}>
            <Icon name={state.warn ? "i-warn" : "i-check"} size={15} style={{ color: state.warn ? "var(--danger)" : "var(--accent)" }} />
            <span className="cfg-name">{status?.location ?? state.label}</span>
            <Tag tone={state.tone}>{state.label}</Tag>
          </div>
          {status?.detail && (
            <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
              {status.detail}
            </p>
          )}
          {remote.data?.remote && (
            <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn-secondary hub-sync" disabled={busy} onClick={syncNow}>
                <Icon name="i-sync" size={13} />
                {sync.isPending ? t("hubPane.syncing") : t("hubPane.syncNow")}
              </button>
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: "var(--space-4)" }}>
        <Eyebrow>{t("restore.hubTitle")}</Eyebrow>
        {missing.length === 0 ? (
          <p className="meta-txt dense hub-others-none" style={{ marginTop: "var(--space-2)" }}>
            {t("restore.hubNone")}
          </p>
        ) : (
          <>
            <div className="stack-1" style={{ marginTop: "var(--space-2)" }}>
              {missing.map((entry) => (
                <RestoreRow key={entry.projectId} entry={entry} />
              ))}
            </div>
            <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
              <button type="button" className="btn btn-secondary hub-attach-all" disabled={busy || missing.every((e) => e.state === "restoring")} onClick={retryAll}>
                <Icon name="i-sync" size={13} />
                {attachAll.isPending ? t("restore.retrying") : t("restore.retryAll")}
              </button>
            </div>
          </>
        )}
        <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
          {t("restore.hubNote")}
        </p>
      </div>
    </>
  );
}

/** Same shape as the project block's remote section; the Hub is bound and synced through its own channels. */
function HubRemoteSection({ bound, location, disabled, providers }: { bound: { provider: string; config: Record<string, unknown> } | null; location: string | null; disabled: boolean; providers: StorageProviderView[] }) {
  const { t, tx } = useI18n();
  const bind = useBindHub();
  const unbind = useUnbindHub();
  const toast = useToast();
  const [edit, setEdit] = useState<{ provider: string; config: Record<string, unknown> } | null>(null);

  const boundId = bound?.provider ?? "";
  const boundConfig = bound?.config ?? {};
  const selected = edit?.provider ?? boundId;
  const config = edit?.config ?? boundConfig;
  const provider = providers.find((p) => p.id === selected);
  const busy = disabled || bind.isPending || unbind.isPending;
  const dirty = !!edit && (edit.provider !== boundId || JSON.stringify(edit.config) !== JSON.stringify(boundConfig));
  const connection = useStorageConnection(provider?.connection ? provider.id : undefined);
  const ready = !provider?.connection || connection.data?.connected === true;

  const choose = (id: string) => {
    const next = providers.find((p) => p.id === id);
    setEdit({ provider: id, config: id === boundId ? { ...boundConfig } : defaultsOf((next?.schema ?? {}) as JsonSchema) });
  };

  const save = () => {
    if (!edit || busy || !edit.provider) return;
    bind.mutate(
      { providerId: edit.provider, config: edit.config },
      {
        onSuccess: (next) => {
          setEdit(null);
          toast({ body: <>{tx("hubPane.publishedToast", { location: <span className="num">{next.location ?? edit.provider}</span> })}</> });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  const forget = () =>
    unbind.mutate(undefined, {
      onSuccess: () => {
        setEdit(null);
        toast({ body: t("hubPane.forgotToast") });
      },
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <div style={{ marginTop: "var(--space-4)" }}>
      <Eyebrow>{t("hubPane.remoteLabel")}</Eyebrow>
      {bound && !edit ? (
        <>
          <div className="cfg-row hub-remote" style={{ marginTop: "var(--space-2)" }}>
            <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
            <span className="cfg-name num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {location ?? providers.find((p) => p.id === bound.provider)?.title ?? bound.provider}
            </span>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => choose(bound.provider)}>
              {t("hubPane.changeRemote")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={forget}>
              {unbind.isPending ? t("hubPane.forgetting") : t("hubPane.forgetRemote")}
            </button>
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            {t("hubPane.boundNote")}
          </p>
        </>
      ) : (
        <>
          <div className="field" style={{ marginTop: "var(--space-2)" }}>
            <label htmlFor="hubProvider">{t("hubPane.remoteKindLabel")}</label>
            <select id="hubProvider" className="input" disabled={busy} value={selected} onChange={(e) => (e.target.value ? choose(e.target.value) : setEdit(null))}>
              <option value="">{t("hubPane.noRemoteOption")}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <span className="meta-txt">{provider?.description ?? t("hubPane.remoteDescFallback")}</span>
          </div>
          {provider?.connection && <ConnectionPanel provider={provider} />}
          {provider && ready && (
            <>
              {provider.browsable && <DestinationPicker provider={provider} onPick={(picked) => setEdit({ provider: selected, config: picked })} />}
              <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
                {(fieldsOf(provider.schema as JsonSchema) ?? []).map(([name, field]) => (
                  <SchemaField key={name} id="hub" name={name} schema={field} disabled={busy} value={config[name]} onChange={(value) => setEdit({ provider: selected, config: { ...config, [name]: value } })} />
                ))}
              </div>
            </>
          )}
          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary hub-publish" disabled={!dirty || busy || !ready || !selected} onClick={save}>
              {bind.isPending ? t("hubPane.publishing") : t("hubPane.publishHere")}
            </button>
            {edit && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
                {t("hubPane.cancel")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
