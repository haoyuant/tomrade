import { useState } from "react";
import type { StorageProviderView, SyncState } from "@tomrade/storage";
import { Icon } from "~/components/icons";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { SchemaField, defaultsOf, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { agoLabel } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useBindStorage, useStorageBinding, useStorageConnection, useStorageProviders, useStorageStatus, useSyncStorage, useUnbindStorage } from "~/lib/queries";
import { ConnectionPanel, DestinationPicker, message } from "./destination";
import { reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";

/** The select value for "this machine": no binding at all, so nothing to keep in step. */
const LOCAL = "";

/**
 * State is shape-coded first: an icon and a word carry it, and the tone only
 * confirms. Three of these need a human, and they say so.
 */
function stateOf(t: (key: MessageKey) => string): Record<SyncState, { label: string; tone: "faint" | "neutral" | "strong"; hint: string; warn?: boolean }> {
  return {
    local: { label: t("storageBlock.stateLocalLabel"), tone: "neutral", hint: t("storageBlock.stateLocalHint") },
    synced: { label: t("storageBlock.stateSyncedLabel"), tone: "faint", hint: t("storageBlock.stateSyncedHint") },
    ahead: { label: t("storageBlock.stateAheadLabel"), tone: "neutral", hint: t("storageBlock.stateAheadHint") },
    behind: { label: t("storageBlock.stateBehindLabel"), tone: "neutral", hint: t("storageBlock.stateBehindHint") },
    diverged: { label: t("storageBlock.stateDivergedLabel"), tone: "strong", hint: t("storageBlock.stateDivergedHint"), warn: true },
    offline: { label: t("storageBlock.stateOfflineLabel"), tone: "strong", hint: t("storageBlock.stateOfflineHint"), warn: true },
    error: { label: t("storageBlock.stateErrorLabel"), tone: "strong", hint: t("storageBlock.stateErrorHint"), warn: true },
    unavailable: { label: t("storageBlock.stateUnavailableLabel"), tone: "strong", hint: t("storageBlock.stateUnavailableHint"), warn: true }
  };
}

export function StorageBlock({ projectId }: { projectId: string }) {
  const { t, tx } = useI18n();
  const STATE = stateOf(t);
  const providers = useStorageProviders();
  const binding = useStorageBinding(projectId);
  const status = useStorageStatus(projectId);
  const bind = useBindStorage(projectId);
  const unbind = useUnbindStorage(projectId);
  const sync = useSyncStorage(projectId);
  const toast = useToast();

  const bound = binding.data?.provider ?? LOCAL;
  const boundConfig = (binding.data?.config ?? {}) as Record<string, unknown>;
  /** Null while the form follows the binding; once set, the draft is the user's. */
  const [edit, setEdit] = useState<{ provider: string; config: Record<string, unknown> } | null>(null);

  const selected = edit?.provider ?? bound;
  const config = edit?.config ?? boundConfig;
  const provider: StorageProviderView | undefined = providers.data?.find((p) => p.id === selected);
  const state = STATE[status.data?.state ?? "local"];
  const busy = bind.isPending || unbind.isPending || sync.isPending;
  const dirty = !!edit && (edit.provider !== bound || JSON.stringify(edit.config) !== JSON.stringify(boundConfig));
  /** A destination that needs an account is not configurable until it has one. */
  const connection = useStorageConnection(provider?.connection ? provider.id : undefined);
  const ready = !provider?.connection || connection.data?.connected === true;

  const choose = (id: string) => {
    const next = providers.data?.find((p) => p.id === id);
    setEdit({ provider: id, config: id === bound ? { ...boundConfig } : defaultsOf((next?.schema ?? {}) as JsonSchema) });
  };

  const save = () => {
    if (!edit || busy) return;
    if (edit.provider === LOCAL) {
      unbind.mutate(undefined, {
        onSuccess: () => {
          setEdit(null);
          toast({ body: t("storageBlock.localOnlyToast") });
        },
        onError: (error) => toast({ body: message(error) })
      });
      return;
    }
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

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) =>
        toast({ body: <>{tx("storageBlock.syncedToast", { label: STATE[next.state].label, location: <span className="num">{next.location ?? ""}</span> })}</> }),
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <div>
      <Eyebrow>{t("storageBlock.whereStored")}</Eyebrow>

      <div className="cfg-row" style={{ marginTop: "var(--space-2)" }}>
        <Icon
          name={state.warn ? "i-warn" : bound === LOCAL ? "i-monitor" : "i-plug"}
          size={15}
          style={{ color: state.warn ? "var(--danger)" : "var(--accent)" }}
        />
        <span className="cfg-name">{status.data?.location ?? state.label}</span>
        {status.data?.lastSyncAt && <span className="meta-txt">{agoLabel(status.data.lastSyncAt)}</span>}
        <Tag tone={state.tone}>{state.label}</Tag>
      </div>

      <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
        {status.data?.detail ? t("storageBlock.hintWithDetail", { hint: state.hint, detail: status.data.detail }) : state.hint}
      </p>

      <div className="field" style={{ marginTop: "var(--space-3)" }}>
        <label htmlFor="stgProvider">{t("storageBlock.destinationLabel")}</label>
        <select id="stgProvider" className="input" disabled={busy} value={selected} onChange={(e) => choose(e.target.value)}>
          <option value={LOCAL}>{t("storageBlock.thisMachineOnly")}</option>
          {(providers.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <span className="meta-txt">{provider?.description ?? t("storageBlock.providerDescFallback")}</span>
      </div>

      {provider?.connection && <ConnectionPanel provider={provider} />}

      {provider && ready && (
        <>
          {provider.browsable && (
            <DestinationPicker provider={provider} onPick={(picked) => setEdit({ provider: selected, config: picked })} />
          )}
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
          </div>
        </>
      )}

      <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" disabled={!dirty || busy || !ready} onClick={save}>
          {bind.isPending
            ? t("storageBlock.publishing")
            : unbind.isPending
              ? t("storageBlock.detaching")
              : selected === LOCAL
                ? t("storageBlock.stopUsingDestination")
                : dirty && bound !== LOCAL && selected !== bound
                  ? t("storageBlock.moveHere")
                  : t("storageBlock.publishHere")}
        </button>
        {bound !== LOCAL && !dirty && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={syncNow}>
            <Icon name="i-undo" size={13} />
            {sync.isPending ? t("storageBlock.syncing") : t("storageBlock.syncNow")}
          </button>
        )}
        {dirty && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
            {t("storageBlock.cancel")}
          </button>
        )}
        {bound !== LOCAL && status.data?.location && !status.data.location.includes("·") && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => reveal(status.data!.location!)}>
            {t("storageBlock.reveal")}
          </button>
        )}
      </div>

      {state.warn && status.data?.state === "diverged" && (
        <div className="dangerbar" style={{ marginTop: "var(--space-3)" }}>
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>{t("storageBlock.divergedWarning")}</p>
        </div>
      )}
    </div>
  );
}
