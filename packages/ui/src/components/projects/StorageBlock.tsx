import { useState } from "react";
import type { StorageInfo, StorageProviderView, SyncState } from "@tomradex/storage";
import { Icon } from "~/components/icons";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { SyncActivity } from "~/components/ui/SyncActivity";
import { SchemaField, defaultsOf, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import {
  useBindStorage,
  useRebuildStorage,
  useSetAutoCommit,
  useSetExports,
  useSetFolder,
  useStorageConnection,
  useStorageInfo,
  useStorageProviders,
  useStorageStatus,
  useSyncStorage,
  useUnbindStorage
} from "~/lib/queries";
import { pickDirectory, reveal, revealLabel } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { useSyncProgress } from "~/lib/syncProgress";
import { ConnectionPanel, DestinationPicker, message } from "./destination";

/**
 * State is shape-coded first: an icon and a word carry it, and the tone only
 * confirms. Those that need a human say so.
 */
function stateOf(t: (key: MessageKey) => string): Record<SyncState, { label: string; tone: "faint" | "neutral" | "strong"; hint: string; warn?: boolean }> {
  return {
    local: { label: t("storageBlock.stateLocalLabel"), tone: "neutral", hint: t("storageBlock.stateLocalHint") },
    synced: { label: t("storageBlock.stateSyncedLabel"), tone: "faint", hint: t("storageBlock.stateSyncedHint") },
    ahead: { label: t("storageBlock.stateAheadLabel"), tone: "neutral", hint: t("storageBlock.stateAheadHint") },
    behind: { label: t("storageBlock.stateBehindLabel"), tone: "neutral", hint: t("storageBlock.stateBehindHint") },
    diverged: { label: t("storageBlock.stateDivergedLabel"), tone: "strong", hint: t("storageBlock.stateDivergedHint"), warn: true },
    syncing: { label: t("storageBlock.stateSyncingLabel"), tone: "neutral", hint: t("storageBlock.stateSyncingHint") },
    offline: { label: t("storageBlock.stateOfflineLabel"), tone: "strong", hint: t("storageBlock.stateOfflineHint"), warn: true },
    error: { label: t("storageBlock.stateErrorLabel"), tone: "strong", hint: t("storageBlock.stateErrorHint"), warn: true },
    unavailable: { label: t("storageBlock.stateUnavailableLabel"), tone: "strong", hint: t("storageBlock.stateUnavailableHint"), warn: true }
  };
}

/** Plugin namespaces the user would recognise by another name. */
const NAMESPACE_LABEL: Partial<Record<string, MessageKey>> = { agent: "storageBlock.exportAgent", code_link: "storageBlock.exportCodeLink" };
/** A namespace nobody named yet still reads as words, not an identifier. */
const humanize = (namespace: string) => namespace.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const useNamespaceLabel = () => {
  const { t } = useI18n();
  return (namespace: string) => {
    const key = NAMESPACE_LABEL[namespace];
    return key ? t(key) : humanize(namespace);
  };
};

/**
 * The project's folder is the truth; this block says where it is, who drives
 * git in it, where it is pushed, what travels in it, and whether the cache and
 * the folder agree. Actions are deliberate — a remote is a draft until saved.
 */
export function StorageBlock({ projectId }: { projectId: string }) {
  const { t, tx } = useI18n();
  const STATE = stateOf(t);
  const labelOf = useNamespaceLabel();
  const info = useStorageInfo(projectId);
  const status = useStorageStatus(projectId);
  const progress = useSyncProgress("storage.progress", projectId, status.data?.progress);
  const setFolder = useSetFolder(projectId);
  const setAutoCommit = useSetAutoCommit(projectId);
  const setExports = useSetExports(projectId);
  const sync = useSyncStorage(projectId);
  const rebuild = useRebuildStorage(projectId);
  const toast = useToast();
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [picking, setPicking] = useState(false);

  const state = STATE[status.data?.state ?? "local"];
  const busy = setFolder.isPending || sync.isPending || rebuild.isPending || setExports.isPending || setAutoCommit.isPending;
  const git = info.data?.git ?? "none";
  const dir = info.data?.dir ?? null;

  const changeFolder = async () => {
    setPicking(true);
    const chosen = await pickDirectory(t("storageBlock.pickFolderTitle"), t("storageBlock.pickFolderButton"));
    setPicking(false);
    if (!chosen) return;
    setFolder.mutate(chosen, {
      onSuccess: (next) => toast({ body: <>{tx("storageBlock.movedToast", { dir: <span className="num">{next.dir ?? chosen}</span> })}</> }),
      onError: (error) => toast({ body: message(error) })
    });
  };

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) =>
        toast({ body: <>{tx("storageBlock.syncedToast", { label: STATE[next.state].label, location: <span className="num">{next.location ?? ""}</span> })}</> }),
      onError: (error) => toast({ body: message(error) })
    });

  const rebuildNow = () => {
    setConfirmRebuild(false);
    rebuild.mutate(undefined, {
      onSuccess: () => toast({ body: t("storageBlock.rebuiltToast") }),
      onError: (error) => toast({ body: message(error) })
    });
  };

  const toggleExport = (namespace: string, on: boolean) => {
    const current = info.data?.exports ?? [];
    const next = on ? [...new Set([...current, namespace])] : current.filter((n) => n !== namespace);
    setExports.mutate(next, { onError: (error) => toast({ body: message(error) }) });
  };
  const closed = info.data?.visibility === "public";
  const privates = (info.data?.exportable ?? []).filter((e) => e.private);
  const privateTicked = privates.filter((e) => info.data!.exports.includes(e.namespace));

  return (
    <div className="storage-block project-settings-body">
      {/* ── the folder ────────────────────────────────────────────────── */}
      <div>
        <Eyebrow>{t("storageBlock.folderLabel")}</Eyebrow>
        <div className="cfg-row" style={{ marginTop: "var(--space-2)" }}>
          <Icon name={git === "none" ? "i-archive" : "i-plug"} size={15} style={{ color: "var(--accent)" }} />
          <span className="cfg-name num stg-dir" style={{ fontFamily: "var(--font-mono)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={dir ?? ""}>
            {dir ?? t("storageBlock.noFolderYet")}
          </span>
          {dir && (
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => reveal(dir)}>
              {t(revealLabel())}
            </button>
          )}
          <button type="button" className="btn btn-ghost stg-change" disabled={busy || picking} onClick={() => void changeFolder()}>
            {picking ? t("storageBlock.choosing") : t("storageBlock.changeFolder")}
          </button>
        </div>
        <p className="meta-txt dense stg-origin" style={{ marginTop: "var(--space-2)" }}>
          {git === "none" && t("storageBlock.originNone")}
          {git === "dedicated" && t("storageBlock.originDedicated")}
          {git === "shared" &&
            tx("storageBlock.originShared", {
              url: <span className="num">{info.data?.origin?.url ?? t("storageBlock.noRemote")}</span>,
              branch: <span className="num">{info.data?.origin?.branch ?? "—"}</span>
            })}
        </p>
        {git === "shared" && (
          <div className="cfg-row" style={{ marginTop: "var(--space-2)" }}>
            <Icon name="i-pen" size={15} style={{ color: info.data?.autoCommit ? "var(--accent)" : "var(--meta)" }} />
            <span className="cfg-name">{t("storageBlock.autoCommitLabel")}</span>
            <button
              type="button"
              className="switch stg-autocommit"
              role="switch"
              aria-checked={!!info.data?.autoCommit}
              aria-label={t("storageBlock.autoCommitAria")}
              disabled={busy}
              onClick={() => setAutoCommit.mutate(!info.data?.autoCommit, { onError: (error) => toast({ body: message(error) }) })}
            />
          </div>
        )}
      </div>

      {/* ── the remote ────────────────────────────────────────────────── */}
      {dir &&
        (git === "shared" ? (
          <SharedRemoteNote />
        ) : (
          <RemoteSection projectId={projectId} bound={info.data?.remote ?? null} location={status.data?.location ?? null} disabled={busy} info={info.data ?? null} onToggle={toggleExport} />
        ))}

      {/* ── what travels ──────────────────────────────────────────────── */}
      {(info.data?.exportable.length ?? 0) > 0 && (
        <div>
          <Eyebrow>{t("storageBlock.travelsLabel")}</Eyebrow>
          <div className="stack-2" style={{ marginTop: "var(--space-2)" }}>
            {info.data!.exportable.map((entry) => {
              const on = info.data!.exports.includes(entry.namespace);
              // A public remote never gets a private namespace, so it is not a choice there.
              const locked = busy || (entry.private && closed);
              return (
                <label key={entry.namespace} className="cfg-row stg-export" style={{ cursor: locked ? "default" : "pointer" }} data-namespace={entry.namespace}>
                  <input type="checkbox" checked={on} disabled={locked} onChange={(e) => toggleExport(entry.namespace, e.target.checked)} />
                  <span className="cfg-name">{labelOf(entry.namespace)}</span>
                  <span className="meta-txt num">{entry.tables.length}</span>
                </label>
              );
            })}
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            {git === "shared" ? t("storageBlock.travelsNoteShared") : t("storageBlock.travelsNote")}
          </p>
          {closed && privates.length > 0 ? (
            <p className="meta-txt dense stg-private-note" data-visibility="public" style={{ marginTop: "var(--space-2)" }}>
              {t("storageBlock.travelsPublicNote", { what: privates.map((e) => labelOf(e.namespace)).join(", ") })}
            </p>
          ) : (
            git !== "none" &&
            privateTicked.length > 0 && (
              <p className="meta-txt dense stg-private-note" style={{ marginTop: "var(--space-2)" }}>
                {t("storageBlock.travelsPrivateNote", { what: privateTicked.map((e) => labelOf(e.namespace)).join(", ") })}
              </p>
            )
          )}
        </div>
      )}

      {/* ── the state ─────────────────────────────────────────────────── */}
      <div>
        <Eyebrow>{t("storageBlock.stateLabel")}</Eyebrow>
        <div className="cfg-row stg-status" style={{ marginTop: "var(--space-2)" }}>
          <Icon name={state.warn ? "i-warn" : "i-check"} size={15} style={{ color: state.warn ? "var(--danger)" : "var(--accent)" }} />
          <span className="cfg-name">{status.data?.location ?? state.label}</span>
          {status.data?.lastSyncAt && <span className="meta-txt">{agoLabel(status.data.lastSyncAt)}</span>}
          <Tag tone={state.tone}>{state.label}</Tag>
        </div>
        <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
          {status.data?.detail ? t("storageBlock.hintWithDetail", { hint: state.hint, detail: status.data.detail }) : state.hint}
        </p>
        <SyncActivity id={`storage:${projectId}`} progress={progress} trace={status.data?.trace} />
        <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-secondary stg-sync" disabled={busy || !dir} onClick={syncNow}>
            <Icon name="i-sync" size={13} />
            {sync.isPending || progress ? t("storageBlock.syncing") : t("storageBlock.syncNow")}
          </button>
          {!confirmRebuild ? (
            <button type="button" className="btn btn-ghost stg-rebuild" disabled={busy || !dir} onClick={() => setConfirmRebuild(true)}>
              {rebuild.isPending ? t("storageBlock.rebuilding") : t("storageBlock.rebuildCache")}
            </button>
          ) : (
            <>
              <span className="meta-txt">{t("storageBlock.rebuildConfirm")}</span>
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={rebuildNow}>
                {t("storageBlock.rebuildYes")}
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmRebuild(false)}>
                {t("storageBlock.cancel")}
              </button>
            </>
          )}
        </div>
        {state.warn && status.data?.state === "diverged" && (
          <div className="dangerbar" style={{ marginTop: "var(--space-3)" }}>
            <Icon className="b-mark" name="i-warn" size={15} />
            <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{t("storageBlock.divergedWarning")}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/** Inside someone's own repository the git is theirs; Tomrade says so instead of offering a picker. */
function SharedRemoteNote() {
  const { t } = useI18n();
  return (
    <div>
      <Eyebrow>{t("storageBlock.remoteLabel")}</Eyebrow>
      <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
        {t("storageBlock.sharedRemoteNote")}
      </p>
    </div>
  );
}

/**
 * Where the project's own repository is pushed. A draft, not commit-on-keystroke:
 * a URL typed character by character would otherwise be seven remotes, and
 * publishing is not something to do by accident.
 */
function RemoteSection({
  projectId,
  bound,
  location,
  disabled,
  info,
  onToggle
}: {
  projectId: string;
  bound: { provider: string; config: Record<string, unknown> } | null;
  location: string | null;
  disabled: boolean;
  info: StorageInfo | null;
  onToggle: (namespace: string, on: boolean) => void;
}) {
  const { t, tx } = useI18n();
  const labelOf = useNamespaceLabel();
  const privates = (info?.exportable ?? []).filter((e) => e.private);
  const providers = useStorageProviders();
  const bind = useBindStorage(projectId);
  const unbind = useUnbindStorage(projectId);
  const toast = useToast();
  /** Null while the form follows the binding; once set, the draft is the user's. */
  const [edit, setEdit] = useState<{ provider: string; config: Record<string, unknown> } | null>(null);

  const boundId = bound?.provider ?? "";
  const boundConfig = bound?.config ?? {};
  const selected = edit?.provider ?? boundId;
  const config = edit?.config ?? boundConfig;
  const provider: StorageProviderView | undefined = providers.data?.find((p) => p.id === selected);
  const busy = disabled || bind.isPending || unbind.isPending;
  const dirty = !!edit && (edit.provider !== boundId || JSON.stringify(edit.config) !== JSON.stringify(boundConfig));
  /** A remote that needs an account is not configurable until it has one. */
  const connection = useStorageConnection(provider?.connection ? provider.id : undefined);
  const ready = !provider?.connection || connection.data?.connected === true;

  const choose = (id: string) => {
    const next = providers.data?.find((p) => p.id === id);
    setEdit({ provider: id, config: id === boundId ? { ...boundConfig } : defaultsOf((next?.schema ?? {}) as JsonSchema) });
  };

  const save = () => {
    if (!edit || busy || !edit.provider) return;
    bind.mutate(
      { providerId: edit.provider, config: edit.config },
      {
        onSuccess: (next) => {
          setEdit(null);
          toast({ body: <>{tx("storageBlock.publishedToast", { location: <span className="num">{next.location ?? edit.provider}</span> })}</> });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  const forget = () =>
    unbind.mutate(undefined, {
      onSuccess: () => {
        setEdit(null);
        toast({ body: t("storageBlock.forgotRemoteToast") });
      },
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <div>
      <Eyebrow>{t("storageBlock.remoteLabel")}</Eyebrow>
      {bound && !edit ? (
        <>
          <div className="cfg-row stg-remote" style={{ marginTop: "var(--space-2)" }}>
            <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
            <span className="cfg-name num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {location ?? providers.data?.find((p) => p.id === bound.provider)?.title ?? bound.provider}
            </span>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => choose(bound.provider)}>
              {t("storageBlock.changeRemote")}
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={forget}>
              {unbind.isPending ? t("storageBlock.forgetting") : t("storageBlock.forgetRemote")}
            </button>
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            {t("storageBlock.remoteBoundNote")}
          </p>
          {info?.visibility === "public" && privates.length > 0 && (
            <div className="dangerbar stg-public" style={{ marginTop: "var(--space-3)" }}>
              <Icon className="b-mark" name="i-warn" size={15} />
              <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
                {t("storageBlock.travelsPublicNote", { what: privates.map((e) => labelOf(e.namespace)).join(", ") })}
              </p>
            </div>
          )}
        </>
      ) : (
        <>
          <div className="field" style={{ marginTop: "var(--space-2)" }}>
            <label htmlFor="stgProvider">{t("storageBlock.remoteKindLabel")}</label>
            <select id="stgProvider" className="input" disabled={busy} value={selected} onChange={(e) => (e.target.value ? choose(e.target.value) : setEdit(null))}>
              <option value="">{t("storageBlock.noRemoteOption")}</option>
              {(providers.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </select>
            <span className="meta-txt">{provider?.description ?? t("storageBlock.remoteDescFallback")}</span>
          </div>

          {provider?.connection && <ConnectionPanel provider={provider} />}

          {provider && ready && (
            <>
              {provider.browsable && <DestinationPicker provider={provider} onPick={(picked) => setEdit({ provider: selected, config: picked })} />}
              <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
                {(fieldsOf(provider.schema as JsonSchema) ?? []).map(([name, field]) => (
                  <SchemaField
                    key={name}
                    id="stg"
                    name={name}
                    schema={field}
                    disabled={busy}
                    value={config[name]}
                    onChange={(value) => setEdit({ provider: selected, config: { ...config, [name]: value } })}
                  />
                ))}
                {provider.connection && <p className="meta-txt dense">{t("storageBlock.travelWithProjectNote")}</p>}
                {/* Said before anything is pushed: conversations go too, unless unticked here. */}
                {privates.map((entry) => (
                  <div key={entry.namespace} className="stack-1 stg-include" data-namespace={entry.namespace}>
                    <label className="cfg-row" style={{ cursor: busy ? "default" : "pointer" }}>
                      <input type="checkbox" checked={info!.exports.includes(entry.namespace)} disabled={busy} onChange={(e) => onToggle(entry.namespace, e.target.checked)} />
                      <span className="cfg-name">{t("storageBlock.includePrivate", { what: labelOf(entry.namespace) })}</span>
                    </label>
                    <p className="meta-txt dense">{t("storageBlock.includePrivateNote")}</p>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
            <button type="button" className="btn btn-secondary stg-publish" disabled={!dirty || busy || !ready || !selected} onClick={save}>
              {bind.isPending ? t("storageBlock.publishing") : t("storageBlock.publishHere")}
            </button>
            {edit && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
                {t("storageBlock.cancel")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
