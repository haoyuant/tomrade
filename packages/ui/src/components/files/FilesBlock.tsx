import { useState } from "react";
import type { FilesBackendView } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { SchemaField, defaultsOf, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { ConnectionPanel, DestinationPicker, message, type RemoteApi } from "~/components/projects/destination";
import { agoLabel } from "~/lib/domain";
import { useBindFiles, useBrowseFiles, useConnectFiles, useDisconnectFiles, useDraftFiles, useFilesBackends, useFilesConnection, useFilesInfo, useFilesStatus, useSyncFiles, useUnbindFiles } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { stateOf } from "./state";
import { SyncPolicySettings, SyncScopeSummary } from "./SyncPolicy";
import { AgentPolicySettings } from "./AgentPolicy";

const filesRemoteApi: RemoteApi = {
  useConnection: useFilesConnection,
  useConnect: useConnectFiles,
  useDisconnect: useDisconnectFiles,
  useBrowse: useBrowseFiles,
  useDraft: useDraftFiles
};

/**
 * Where a project's files live on this machine, where they are shared, and
 * how the two stand. The remote is a draft until saved: sharing a folder of
 * documents is not something to do by accident.
 */
export function FilesBlock({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const STATE = stateOf(t);
  const info = useFilesInfo(projectId);
  const status = useFilesStatus(projectId);
  const sync = useSyncFiles(projectId);
  const toast = useToast();
  const state = STATE[status.data?.state ?? "local"];
  const dir = info.data?.dir ?? null;

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) => toast({ body: t("files.syncedToast", { label: STATE[next.state].label.toLowerCase() }) }),
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <div className="storage-block files-block project-settings-body">
      <div>
        <Eyebrow>{t("files.blockLabel")}</Eyebrow>
        <div className="cfg-row" style={{ marginTop: "var(--space-2)" }}>
          <Icon name="i-folder" size={15} style={{ color: "var(--accent)" }} />
          <span className="cfg-name num" style={{ fontFamily: "var(--font-mono)", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={dir ?? ""}>
            {dir ?? t("files.stateUnavailableHint")}
          </span>
          {dir && (
            <button type="button" className="btn btn-ghost" onClick={() => reveal(dir)}>
              {t("files.reveal")}
            </button>
          )}
        </div>
        <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
          {t("files.folderNote")}
        </p>
      </div>

      {dir && <SyncPolicySettings projectId={projectId} />}
      {dir && <AgentPolicySettings projectId={projectId} />}
      {dir && <RemoteSection projectId={projectId} bound={info.data?.remote ?? null} location={status.data?.location ?? null} disabled={sync.isPending} />}

      <div>
        <Eyebrow>{t("files.stateLabel")}</Eyebrow>
        <div className="cfg-row files-status" style={{ marginTop: "var(--space-2)" }} data-state={status.data?.state ?? "local"}>
          <Icon name={state.warn ? "i-warn" : "i-check"} size={15} style={{ color: state.warn ? "var(--danger)" : "var(--accent)" }} />
          <span className="cfg-name">{status.data?.location ?? state.label}</span>
          {status.data?.lastSyncAt && <span className="meta-txt">{agoLabel(status.data.lastSyncAt)}</span>}
          <Tag tone={state.tone}>{state.label}</Tag>
        </div>
        <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
          {status.data?.detail ? t("files.hintWithDetail", { hint: state.hint, detail: status.data.detail }) : state.hint}
        </p>
        <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
          <button type="button" className="btn btn-secondary files-sync" disabled={sync.isPending || !dir} onClick={syncNow}>
            <Icon name="i-sync" size={13} />
            {sync.isPending ? t("files.syncing") : t("files.syncNow")}
          </button>
        </div>
      </div>
    </div>
  );
}

function RemoteSection({ projectId, bound, location, disabled }: { projectId: string; bound: { backend: string; config: Record<string, unknown> } | null; location: string | null; disabled: boolean }) {
  const { t } = useI18n();
  const backends = useFilesBackends();
  const bind = useBindFiles(projectId);
  const unbind = useUnbindFiles(projectId);
  const toast = useToast();
  /** Null while the form follows the binding; once set, the draft is the user's. */
  const [edit, setEdit] = useState<{ backend: string; config: Record<string, unknown> } | null>(null);

  // The local backend is the absence of a remote; the picker offers the others.
  const remotes = (backends.data ?? []).filter((b) => b.id !== "local");
  const boundId = bound?.backend ?? "";
  const boundConfig = bound?.config ?? {};
  const selected = edit?.backend ?? boundId;
  const config = edit?.config ?? boundConfig;
  const backend: FilesBackendView | undefined = remotes.find((b) => b.id === selected);
  const busy = disabled || bind.isPending || unbind.isPending;
  const dirty = !!edit && (edit.backend !== boundId || JSON.stringify(edit.config) !== JSON.stringify(boundConfig));
  const connection = useFilesConnection(backend?.connection ? backend.id : undefined);
  const ready = !backend?.connection || connection.data?.connected === true;

  const choose = (id: string) => {
    const next = remotes.find((b) => b.id === id);
    setEdit({ backend: id, config: id === boundId ? { ...boundConfig } : { ...defaultsOf((next?.schema ?? {}) as JsonSchema), ...(id === "github" ? { directory: "project-files" } : {}) } });
  };

  const save = () => {
    if (!edit || busy || !edit.backend) return;
    bind.mutate(
      { backendId: edit.backend, config: edit.config },
      {
        onSuccess: (next) => {
          setEdit(null);
          toast({ body: t("files.sharedToast", { location: next.location ?? edit.backend }) });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  const stop = () =>
    unbind.mutate(undefined, {
      onSuccess: () => {
        setEdit(null);
        toast({ body: t("files.stoppedToast") });
      },
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <div>
      <Eyebrow>{t("files.sharingLabel")}</Eyebrow>
      {bound && !edit ? (
        <>
          <div className="cfg-row files-remote" style={{ marginTop: "var(--space-2)" }}>
            <Icon name="i-plug" size={15} style={{ color: "var(--accent)" }} />
            <span className="cfg-name num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {location ?? remotes.find((b) => b.id === bound.backend)?.title ?? bound.backend}
            </span>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => choose(bound.backend)}>
              {t("files.changeRemote")}
            </button>
            <button type="button" className="btn btn-ghost files-unbind" disabled={busy} onClick={stop}>
              {unbind.isPending ? t("files.stopping") : t("files.stopSharing")}
            </button>
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            {t("files.sharedNote")}
          </p>
        </>
      ) : (
        <>
          <div className="field" style={{ marginTop: "var(--space-2)" }}>
            <label htmlFor="filesBackend">{t("files.whereShared")}</label>
            <select id="filesBackend" className="input" disabled={busy} value={selected} onChange={(e) => (e.target.value ? choose(e.target.value) : setEdit(null))}>
              <option value="">{t("files.noneOption")}</option>
              {remotes.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
            <span className="meta-txt">{backend?.description ?? t("files.backendDescFallback")}</span>
          </div>

          {backend?.connection && <ConnectionPanel provider={backend} api={filesRemoteApi} />}

          {backend && ready && (
            <>
              {backend.browsable && <DestinationPicker provider={backend} api={filesRemoteApi} onPick={(picked) => setEdit({ backend: selected, config: { ...config, ...picked, ...(selected === boundId && selected === "github" ? { directory: config.directory ?? "" } : {}) } })} />}
              <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
                {bound && selected === boundId && (config.directory ?? "") !== (boundConfig.directory ?? "") && <p className="meta-txt dense" role="status">{t("files.syncScopeChange", { from: String(boundConfig.directory || t("files.remoteRoot")), to: String(config.directory || t("files.remoteRoot")) })}</p>}
                {(fieldsOf(backend.schema as JsonSchema) ?? []).map(([name, field]) => (
                  <SchemaField key={name} id="files" name={name} schema={field} disabled={busy} value={config[name]} onChange={(value) => setEdit({ backend: selected, config: { ...config, [name]: value } })} />
                ))}
                <p className="meta-txt dense">{t("files.travelNote")}</p>
              </div>
            </>
          )}

          <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
            {!bound && selected && <SyncScopeSummary projectId={projectId} binding />}
            <button type="button" className="btn btn-secondary files-bind" disabled={!dirty || busy || !ready || !selected} onClick={save}>
              {bind.isPending ? t("files.sharingBusy") : t("files.shareHere")}
            </button>
            {edit && (
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
                {t("files.cancel")}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
