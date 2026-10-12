import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ConnectionState, StorageProviderView } from "@tomradex/storage";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import {
  useBrowseStorage,
  useConnectStorage,
  useDisconnectStorage,
  useDraftStorage,
  useSignInStorage,
  useStorageConnection
} from "~/lib/queries";
import { openExternal } from "~/lib/shell";
import { PlainSecretNote } from "~/components/ui/PlainSecretNote";
import { readableError, useToast } from "~/lib/toast";

/** The words of a failure, without the IPC wrapper or the class name. */
export const message = (error: unknown): string => readableError(error);

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
  useSignIn: () => { isPending: boolean; mutate: (providerId: string, opts?: { onSuccess?: (next: ConnectionState) => void; onError?: (error: Error) => void }) => void };
  useDisconnect: () => { isPending: boolean; mutate: (providerId: string, opts?: { onSuccess?: () => void }) => void };
  useBrowse: () => { isPending: boolean; data?: unknown; mutate: (providerId: string, opts?: { onError?: (error: Error) => void }) => void };
  useDraft: () => { isPending: boolean; mutate: (args: { providerId: string; name: string }, opts?: { onSuccess?: (config: unknown) => void; onError?: (error: Error) => void }) => void };
}

export const storageRemoteApi: RemoteApi = {
  useConnection: useStorageConnection,
  useConnect: useConnectStorage,
  useSignIn: useSignInStorage,
  useDisconnect: useDisconnectStorage,
  useBrowse: useBrowseStorage,
  useDraft: useDraftStorage
};

/**
 * The account a destination needs, asked for where it is needed. One account
 * serves every project, so the provider keeps it per machine — but a settings
 * card of its own would make you leave to come back, and leave you guessing
 * whether it took. A provider that can sign in through the browser offers that
 * first; its secret stays as the way in when signing in does not work.
 */
export function ConnectionPanel({ provider, api = storageRemoteApi }: { provider: RemoteProviderView; api?: RemoteApi }) {
  const { t, tx } = useI18n();
  const state = api.useConnection(provider.id);
  const connect = api.useConnect();
  const signIn = api.useSignIn();
  const disconnect = api.useDisconnect();
  const toast = useToast();
  const qc = useQueryClient();
  const [secret, setSecret] = useState("");
  const [withSecret, setWithSecret] = useState(false);
  const prompt = provider.connection;
  const pending = state.data?.pending;
  const connected = !!state.data?.connected;

  // A sign-in that lands while the panel waits: say so, and let every other panel asking about accounts see it.
  const waiting = useRef(false);
  useEffect(() => {
    if (pending) waiting.current = true;
    else if (waiting.current) {
      waiting.current = false;
      if (connected) toast({ body: t("destination.connectedToast", { label: state.data?.label ?? "" }) });
      for (const key of ["storage", "files", "codeLink"]) void qc.invalidateQueries({ queryKey: [key] });
    }
  }, [pending, connected]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const copy = (code: string) => void navigator.clipboard?.writeText(code).catch(() => {});
  const startSignIn = () =>
    signIn.mutate(provider.id, {
      onSuccess: (next) => {
        if (!next.pending) return;
        copy(next.pending.code);
        openExternal(next.pending.url);
      },
      onError: (error) => toast({ body: message(error) })
    });

  if (connected) {
    const action = state.data?.action;
    return (
      <div className="stack-2" style={{ marginTop: "var(--space-3)" }}>
        <div className="cfg-row">
          <Icon name="i-check" size={15} style={{ color: "var(--accent)" }} />
          <span className="cfg-name">{state.data?.label ? t("destination.connectedAs", { label: state.data.label }) : t("destination.connectedPlain")}</span>
          {action && !action.needed && (
            <button type="button" className="btn btn-ghost" onClick={() => openExternal(action.url)}>
              {action.label}
            </button>
          )}
          <button
            type="button"
            className="btn btn-ghost"
            disabled={disconnect.isPending}
            onClick={() => disconnect.mutate(provider.id, { onSuccess: () => toast({ body: t("destination.disconnectedToast") }) })}
          >
            {t("destination.disconnect")}
          </button>
        </div>
        {action?.needed && (
          <div className="panel row" style={{ gap: "var(--space-3)", justifyContent: "space-between" }} data-testid="connection-action">
            <span className="meta-txt">{action.label}</span>
            <button type="button" className="btn btn-secondary" onClick={() => openExternal(action.url)}>
              <Icon name="i-plug" size={13} />
              {tx("destination.openPage", { host: hostOf(action.url) })}
            </button>
          </div>
        )}
      </div>
    );
  }

  if (pending) {
    const host = hostOf(pending.url);
    return (
      <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }} data-testid="connection-pending">
        <span className="meta-txt">{t("destination.enterCode", { host })}</span>
        <div className="row" style={{ gap: "var(--space-3)", alignItems: "center" }}>
          <span className="num" style={{ fontSize: 22, letterSpacing: "0.12em", color: "var(--fg)" }} data-testid="device-code">
            {pending.code}
          </span>
          <button type="button" className="btn btn-ghost" onClick={() => copy(pending.code)}>
            {t("destination.copyCode")}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => openExternal(pending.url)}>
            {tx("destination.openPage", { host })}
          </button>
        </div>
        <span className="meta-txt">{t("destination.codeCopied")}</span>
        <div className="row" style={{ gap: "var(--space-2)", alignItems: "center", justifyContent: "space-between" }}>
          <span className="meta-txt">{t("destination.waiting", { host })}</span>
          <button type="button" className="btn btn-ghost" onClick={() => disconnect.mutate(provider.id)}>
            {t("destination.cancelSignIn")}
          </button>
        </div>
      </div>
    );
  }

  const failure = state.data && !state.data.connected && state.data.detail && (
    <span className="meta-txt" style={{ color: "var(--danger)" }}>
      {state.data.detail}
    </span>
  );

  if (prompt.signIn && !withSecret) {
    return (
      <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
        <button type="button" className="btn btn-secondary" style={{ alignSelf: "flex-start" }} disabled={signIn.isPending} onClick={startSignIn} data-testid="connection-sign-in">
          <Icon name="i-plug" size={13} />
          {signIn.isPending ? t("destination.signingIn") : t("destination.signInWith", { name: prompt.signIn.name })}
        </button>
        {failure}
        <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setWithSecret(true)} data-testid="connection-use-secret">
          {t("destination.useTokenInstead")}
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
        <PlainSecretNote />
        {failure}
      </div>
      <div className="row" style={{ gap: "var(--space-2)" }}>
        {prompt.url && (
          <button type="button" className="btn btn-ghost" onClick={() => openExternal(prompt.url!)}>
            <Icon name="i-plug" size={13} />
            {tx("destination.getOneFrom", { host: hostOf(prompt.url) })}
          </button>
        )}
        {prompt.signIn && (
          <button type="button" className="btn btn-ghost" onClick={() => setWithSecret(false)}>
            {t("destination.signInWith", { name: prompt.signIn.name })}
          </button>
        )}
      </div>
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
