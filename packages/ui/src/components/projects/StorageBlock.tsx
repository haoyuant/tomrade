import { useState } from "react";
import type { StorageProviderView, SyncState } from "@tomrade/storage";
import { Icon } from "~/components/icons";
import { Eyebrow, Num, Tag } from "~/components/ui/atoms";
import { SchemaField, defaultsOf, fieldsOf, type JsonSchema } from "~/components/ui/schema-form";
import { agoLabel } from "~/lib/domain";
import { useBindStorage, useStorageBinding, useStorageProviders, useStorageStatus, useSyncStorage, useUnbindStorage } from "~/lib/queries";
import { reveal } from "~/lib/shell";
import { useToast } from "~/lib/toast";

/** The select value for "this machine": no binding at all, so nothing to keep in step. */
const LOCAL = "";

/**
 * State is shape-coded first: an icon and a word carry it, and the tone only
 * confirms. Three of these need a human, and they say so.
 */
const STATE: Record<SyncState, { label: string; tone: "faint" | "neutral" | "strong"; hint: string; warn?: boolean }> = {
  local: { label: "This machine", tone: "neutral", hint: "The only copy is the database on this machine." },
  synced: { label: "Published", tone: "faint", hint: "The destination holds exactly what this project holds." },
  ahead: { label: "Not yet published", tone: "neutral", hint: "Local changes are waiting to be published." },
  behind: { label: "Changes waiting", tone: "neutral", hint: "The destination has changes this machine has not taken yet." },
  diverged: { label: "Both sides changed", tone: "strong", hint: "This machine and the destination both moved on. Nothing is overwritten until you choose.", warn: true },
  offline: { label: "Cannot reach it", tone: "strong", hint: "The destination did not answer. Local work is safe and will publish when it does.", warn: true },
  error: { label: "Something is wrong", tone: "strong", hint: "The destination could not be read.", warn: true },
  unavailable: { label: "Provider not loaded", tone: "strong", hint: "The plugin that knows this destination is not loaded, so it cannot be reached.", warn: true }
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Where a project's shareable copy lives. A draft, not commit-on-keystroke: a
 * path typed character by character would otherwise be seven destinations, and
 * publishing is not something to do by accident.
 */
export function StorageBlock({ projectId }: { projectId: string }) {
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
          toast({ body: <>Stored on this machine only — the files at the old destination were left alone</> });
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
          toast({ body: <>Published to <span className="num">{next.location ?? edit.provider}</span></> });
        },
        onError: (error) => toast({ body: message(error) })
      }
    );
  };

  const syncNow = () =>
    sync.mutate(undefined, {
      onSuccess: (next) => toast({ body: <>{STATE[next.state].label} · <span className="num">{next.location ?? ""}</span></> }),
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <div>
      <Eyebrow>Where this project is stored</Eyebrow>

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
        {status.data?.detail ? `${state.hint} ${status.data.detail}.` : state.hint}
      </p>

      <div className="field" style={{ marginTop: "var(--space-3)" }}>
        <label htmlFor="stgProvider">Destination</label>
        <select id="stgProvider" className="input" disabled={busy} value={selected} onChange={(e) => choose(e.target.value)}>
          <option value={LOCAL}>This machine only</option>
          {(providers.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </select>
        <span className="meta-txt">
          {provider?.description ?? "The live database always stays on this machine. A destination receives a copy of the project as text."}
        </span>
      </div>

      {provider && (
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
          {provider.settingsSection && (
            <p className="meta-txt dense">
              Credentials for this destination live in <Num>Settings → {provider.title}</Num>, never in the project — a project's own settings travel with it.
            </p>
          )}
        </div>
      )}

      <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", flexWrap: "wrap" }}>
        <button type="button" className="btn btn-secondary" disabled={!dirty || busy} onClick={save}>
          {bind.isPending ? "Publishing…" : unbind.isPending ? "Detaching…" : selected === LOCAL ? "Stop using a destination" : dirty && bound !== LOCAL && selected !== bound ? "Move here" : "Publish here"}
        </button>
        {bound !== LOCAL && !dirty && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={syncNow}>
            <Icon name="i-undo" size={13} />
            {sync.isPending ? "Syncing…" : "Sync now"}
          </button>
        )}
        {dirty && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setEdit(null)}>
            Cancel
          </button>
        )}
        {bound !== LOCAL && status.data?.location && !status.data.location.includes("·") && (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => reveal(status.data!.location!)}>
            Reveal
          </button>
        )}
      </div>

      {state.warn && status.data?.state === "diverged" && (
        <div className="dangerbar" style={{ marginTop: "var(--space-3)" }}>
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
            Both this machine and the destination changed. Neither is overwritten: publishing and syncing both refuse until the two agree. Take the
            destination's copy by hand, or move this project to a destination of its own.
          </p>
        </div>
      )}
    </div>
  );
}
