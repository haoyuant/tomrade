import { useState } from "react";
import type { StorageProviderView } from "@tomrade/storage";
import { Icon } from "~/components/icons";
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

/**
 * The account a destination needs, asked for where it is needed. One account
 * serves every project, so the provider keeps it per machine — but a settings
 * card of its own would make you leave to come back, and leave you guessing
 * whether it took.
 */
export function ConnectionPanel({ provider }: { provider: StorageProviderView }) {
  const state = useStorageConnection(provider.id);
  const connect = useConnectStorage();
  const disconnect = useDisconnectStorage();
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
          toast({ body: next.connected ? <>Connected {next.label ?? ""}</> : <>{next.detail ?? "That was not accepted"}</> });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  if (state.data?.connected) {
    return (
      <div className="cfg-row" style={{ marginTop: "var(--space-3)" }}>
        <Icon name="i-check" size={15} style={{ color: "var(--accent)" }} />
        <span className="cfg-name">Connected{state.data.label ? ` as ${state.data.label}` : ""}</span>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate(provider.id, { onSuccess: () => toast({ body: <>Disconnected. Published copies are left where they are.</> }) })}
        >
          Disconnect
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
            {connect.isPending ? "Connecting…" : "Connect"}
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
          Get one from {hostOf(prompt.url)}
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
export function DestinationPicker({ provider, onPick }: { provider: StorageProviderView; onPick: (config: Record<string, unknown>) => void }) {
  const browse = useBrowseStorage();
  const draft = useDraftStorage();
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
        Choose an existing one…
      </button>
    );
  }

  return (
    <div className="panel stack-3" style={{ marginTop: "var(--space-3)" }}>
      <div className="field">
        <label htmlFor="stgFilter">Find it by name</label>
        <input id="stgFilter" autoFocus className="input" autoComplete="off" placeholder="Start typing…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      {browse.isPending && <p className="meta-txt dense">Asking…</p>}
      {!browse.isPending && !results.length && <p className="meta-txt dense">Nothing to choose from yet.</p>}
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
              <span className="m-name">Create {filter.trim()}</span>
              <span className="m-sub">Made when you publish, and private if the host allows it</span>
            </span>
          </button>
        )}
      </div>
      <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

/**
 * Where a project's shareable copy lives. A draft, not commit-on-keystroke: a
 * path typed character by character would otherwise be seven destinations, and
 * publishing is not something to do by accident.
 */
