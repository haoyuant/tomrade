import { useState } from "react";
import type { ConnectionState, StorageProviderView } from "@tomrade/storage";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import {
  useBrowseStorage,
  useConnectStorage,
  useDisconnectStorage,
  useDraftStorage,
  useStorageConnection
} from "~/lib/queries";
import { openExternal } from "~/lib/shell";
import { useToast } from "~/lib/toast";

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What the panels below need of a remote's description; storage providers and files backends both have it. */
export type RemoteProviderView = Pick<StorageProviderView, "id" | "title" | "connection" | "browsable" | "creatable">;

/**
 * The hooks behind a remote's account and candidates. Storage and Files each
 * have their own channels, so the panels take theirs from here rather than
 * knowing which registry they are drawing for.
 */
export interface RemoteApi {
  useConnection: (providerId: string | undefined) => { data?: ConnectionState };
  useConnect: () => { isPending: boolean; mutate: (args: { providerId: string; secret: string }, opts?: { onSuccess?: (next: ConnectionState) => void; onError?: (error: Error) => void }) => void };
  useDisconnect: () => { isPending: boolean; mutate: (providerId: string, opts?: { onSuccess?: () => void }) => void };
  useBrowse: () => { isPending: boolean; data?: unknown; mutate: (providerId: string, opts?: { onError?: (error: Error) => void }) => void };
  useDraft: () => { isPending: boolean; mutate: (args: { providerId: string; name: string }, opts?: { onSuccess?: (config: unknown) => void; onError?: (error: Error) => void }) => void };
}

export const storageRemoteApi: RemoteApi = {
  useConnection: useStorageConnection,
  useConnect: useConnectStorage,
  useDisconnect: useDisconnectStorage,
  useBrowse: useBrowseStorage,
  useDraft: useDraftStorage
};

/**
 * The account a destination needs, asked for where it is needed. One account
 * serves every project, so the provider keeps it per machine — but a settings
 * card of its own would make you leave to come back, and leave you guessing
 * whether it took.
 */
export function ConnectionPanel({ provider, api = storageRemoteApi }: { provider: RemoteProviderView; api?: RemoteApi }) {
  const { t, tx } = useI18n();
  const state = api.useConnection(provider.id);
  const connect = api.useConnect();
  const disconnect = api.useDisconnect();
  const toast = useToast();
  const [secret, setSecret] = useState("");
  const prompt = provider.connection;
  if (!prompt) return null;

  const submit = () => {
    if (!secret.trim() || connect.isPending) return;
    connect.mutate(
      { providerId: provider.id, secret },
      {
        onSuccess: (next) => {
          setSecret("");
          toast({ body: next.connected ? t("destination.connectedToast", { label: next.label ?? "" }) : (next.detail ?? t("destination.notAccepted")) });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  if (state.data?.connected) {
    return (
      <div className="cfg-row" style={{ marginTop: "var(--space-3)" }}>
        <Icon name="i-check" size={15} style={{ color: "var(--accent)" }} />
        <span className="cfg-name">{state.data.label ? t("destination.connectedAs", { label: state.data.label }) : t("destination.connectedPlain")}</span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate(provider.id, { onSuccess: () => toast({ body: t("destination.disconnectedToast") }) })}
        >
          {t("destination.disconnect")}
        </button>
      </div>
    );
  }

  return (
    <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
      <div className="field">
        <label htmlFor="stgSecret">{prompt.label}</label>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <input
            id="stgSecret"
            className="input num"
            type="password"
            style={{ flex: 1 }}
            autoComplete="off"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
          <button type="button" className="btn btn-secondary" disabled={!secret.trim() || connect.isPending} onClick={submit}>
            {connect.isPending ? t("destination.connecting") : t("destination.connect")}
          </button>
        </div>
        {prompt.help && <span className="meta-txt">{prompt.help}</span>}
        {state.data && !state.data.connected && state.data.detail && (
          <span className="meta-txt" style={{ color: "var(--danger)" }}>
            {state.data.detail}
          </span>
        )}
      </div>
      {prompt.url && (
        <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => openExternal(prompt.url!)}>
          <Icon name="i-plug" size={13} />
          {tx("destination.getOneFrom", { host: hostOf(prompt.url) })}
        </button>
      )}
    </div>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Nothing typed by hand: a provider that can list what an account already has
 * lists it, and one that can make a destination from a name offers that too.
 */
export function DestinationPicker({ provider, onPick, api = storageRemoteApi }: { provider: RemoteProviderView; onPick: (config: Record<string, unknown>) => void; api?: RemoteApi }) {
  const { t } = useI18n();
  const browse = api.useBrowse();
  const draft = api.useDraft();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const results = (browse.data ?? []) as { label: string; config: Record<string, unknown> }[];
  const needle = filter.trim().toLowerCase();
  const shown = results.filter((r) => r.label.toLowerCase().includes(needle)).slice(0, 40);
  const canCreate = provider.creatable && needle.length > 0 && !results.some((r) => r.label.toLowerCase() === needle);

  if (!open) {
    return (
      <button
        type="button"
        className="btn btn-secondary"
        style={{ marginTop: "var(--space-3)" }}
        onClick={() => {
          setOpen(true);
          browse.mutate(provider.id, { onError: (error) => toast({ body: message(error) }) });
        }}
      >
        <Icon name="i-search" size={13} />
        {t("destination.chooseExisting")}
      </button>
    );
  }

  return (
    <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
      <div className="field">
        <label htmlFor="stgFilter">{t("destination.findByName")}</label>
        <input
          id="stgFilter"
          autoFocus
          className="input"
          autoComplete="off"
          placeholder={t("destination.findPlaceholder")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      {browse.isPending && <p className="meta-txt dense">{t("destination.asking")}</p>}
      {!browse.isPending && !results.length && <p className="meta-txt dense">{t("destination.nothingToChoose")}</p>}
      <div className="stack-2" style={{ maxHeight: 220, overflowY: "auto" }}>
        {shown.map((row) => (
          <button
            key={row.label}
            type="button"
            className="menu-row"
            onClick={() => {
              onPick(row.config);
              setOpen(false);
            }}
          >
            <span className="m-mark">
              <Icon name="i-plug" size={13} />
            </span>
            <span className="m-name">{row.label}</span>
          </button>
        ))}
        {canCreate && (
          <button
            type="button"
            className="menu-row"
            disabled={draft.isPending}
            onClick={() =>
              draft.mutate(
                { providerId: provider.id, name: filter.trim() },
                {
                  onSuccess: (config) => {
                    onPick(config as Record<string, unknown>);
                    setOpen(false);
                  },
                  onError: (error) => toast({ body: message(error) })
                }
              )
            }
          >
            <span className="m-mark">
              <Icon name="i-plus" size={13} />
            </span>
            <span className="m-stack">
              <span className="m-name">{t("destination.createLabel", { name: filter.trim() })}</span>
              <span className="m-sub">{t("destination.createSub")}</span>
            </span>
          </button>
        )}
      </div>
      <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(false)}>
        {t("destination.cancel")}
      </button>
    </div>
  );
}

/**
 * Where a project's shareable copy lives. A draft, not commit-on-keystroke: a
 * path typed character by character would otherwise be seven destinations, and
 * publishing is not something to do by accident.
 */
