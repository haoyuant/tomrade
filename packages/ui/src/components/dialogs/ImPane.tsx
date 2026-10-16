import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ImAdapterView, ImConnectionView, ImIgnoredView, ImPairingView, ImRoute, ImSettings } from "@tomradex/im";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { invoke, messageOf } from "~/lib/api";
import { useEngines } from "~/lib/agent";
import { useI18n, type MessageKey } from "~/lib/i18n";
import {
  useImAdapters, useImAllow, useImConnections, useImDeliveries, useImDiscard, useImIgnored,
  useImPairCancel, useImPairConfirm, useImPairings, useImPairStart, useImRetry, useImRevoke
} from "~/lib/im";
import { useProjects, useSaveSettings, useSettings } from "~/lib/queries";
import { cn } from "~/lib/utils";

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const EMPTY: ImSettings = { connections: [], identities: [], routes: [] };

const STATE_KEY: Record<ImConnectionView["state"], MessageKey> = {
  connecting: "imSettings.stateConnecting",
  connected: "imSettings.stateConnected",
  offline: "imSettings.stateOffline",
  error: "imSettings.stateError",
  unconfigured: "imSettings.stateUnconfigured"
};
const REASON_KEY: Record<ImIgnoredView["reason"], MessageKey> = {
  actor: "imSettings.reasonActor",
  conversation: "imSettings.reasonConversation",
  activation: "imSettings.reasonActivation",
  bot: "imSettings.reasonBot"
};

function useSecretStorage() {
  return useQuery({ queryKey: ["settings", "secretStorage"], queryFn: () => invoke("settings.secretStorage"), staleTime: Infinity, retry: false });
}

function ProjectSelect({ id, value, onChange }: { id?: string; value: string; onChange: (projectId: string) => void }) {
  const projects = useProjects();
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {(projects.data ?? []).filter((p) => !p.archived || p.id === value).map((p) => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}

/** The wizard: what to do on the platform, then the values it hands back. */
function ConnectionForm({ adapters, initial, taken, plaintext, busy, onSave, onCancel }: {
  adapters: ImAdapterView[]; initial?: ImSettings["connections"][number]; taken: string[]; plaintext: boolean; busy: boolean;
  onSave: (connection: ImSettings["connections"][number]) => void; onCancel: () => void;
}) {
  const { t } = useI18n();
  const [adapterId, setAdapterId] = useState(initial?.adapterId ?? adapters[0]?.id ?? "");
  const [id, setId] = useState(initial?.id ?? "");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [credentials, setCredentials] = useState<Record<string, string>>(initial?.credentials ?? {});
  const [consent, setConsent] = useState(false);
  const [copied, setCopied] = useState(false);
  const adapter = adapters.find((a) => a.id === adapterId);
  const fields = adapter?.setup?.fields ?? [];
  const idError = !ID.test(id) ? t("imSettings.idInvalid") : taken.includes(id) ? t("imSettings.idTaken") : null;
  const missing = fields.some((f) => !f.optional && !credentials[f.key]?.trim());
  const secretsChanged = JSON.stringify(credentials) !== JSON.stringify(initial?.credentials ?? {});
  const valid = !!adapter && !idError && !missing && (!plaintext || !secretsChanged || !fields.length || consent);
  return (
    <div className="panel stack-3" style={{ background: "var(--bg)" }} data-testid="im-form">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="im-adapter">{t("imSettings.platform")}</label>
          <select id="im-adapter" className="input" value={adapterId} disabled={!!initial} onChange={(e) => setAdapterId(e.target.value)}>
            {adapters.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="im-id">{t("imSettings.idLabel")}</label>
          <input id="im-id" className="input mono" value={id} disabled={!!initial} placeholder="team-bot" aria-invalid={!!idError && !!id} onChange={(e) => setId(e.target.value.trim())} />
          <span className="meta-txt" style={idError && id ? { color: "var(--danger)" } : undefined}>{idError && id ? idError : t("imSettings.idHint")}</span>
        </div>
      </div>
      <div className="field">
        <label htmlFor="im-label">{t("imSettings.nameLabel")}</label>
        <input id="im-label" className="input" value={label} placeholder={t("imSettings.optional")} onChange={(e) => setLabel(e.target.value)} />
      </div>
      {adapter?.setup && (
        <>
          {adapter.setup.steps.length > 0 && (
            <div className="field">
              <label>{t("imSettings.steps")}</label>
              <ol className="meta-txt" style={{ margin: 0, paddingLeft: 18, whiteSpace: "pre-wrap" }}>
                {adapter.setup.steps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
              {adapter.setup.docsUrl && <a className="meta-txt" href={adapter.setup.docsUrl} target="_blank" rel="noreferrer">{t("imSettings.docs")}</a>}
            </div>
          )}
          {adapter.setup.permissions.length > 0 && (
            <div className="field">
              <label>{t("imSettings.permissions")}</label>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {adapter.setup.permissions.map((p) => <span key={p} className="mono"><Tag tone="faint">{p}</Tag></span>)}
              </div>
            </div>
          )}
          {adapter.setup.manifest && (
            <div className="field">
              <label htmlFor="im-manifest">{t("imSettings.manifest")}</label>
              <textarea id="im-manifest" className="input mono" rows={6} readOnly value={adapter.setup.manifest.text} />
              <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => {
                void navigator.clipboard.writeText(adapter.setup!.manifest!.text).then(() => setCopied(true));
              }}>
                <Icon name={copied ? "i-check" : "i-copy"} size={13} /> {copied ? t("imSettings.copied") : t("imSettings.copy")}
              </button>
            </div>
          )}
          {fields.length > 0 && (
            <fieldset className="stack-2" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>{t("imSettings.credentials")}</legend>
              {fields.map((f) => (
                <div className="field" key={f.key}>
                  <label htmlFor={`im-cred-${f.key}`}>{f.label}{f.optional ? ` · ${t("imSettings.optional")}` : ""}</label>
                  <input id={`im-cred-${f.key}`} className="input mono" type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder}
                    value={credentials[f.key] ?? ""} onChange={(e) => setCredentials({ ...credentials, [f.key]: e.target.value })} />
                  {f.help && <span className="meta-txt">{f.help}</span>}
                </div>
              ))}
              {plaintext && secretsChanged && (
                <label className="row meta-txt" style={{ gap: 6, color: "var(--warn)" }}>
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} data-testid="im-plaintext-consent" />
                  {t("imSettings.plaintextConsent")}
                </label>
              )}
            </fieldset>
          )}
        </>
      )}
      <span className="meta-txt">{t("imSettings.saveHint")}</span>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={!valid || busy} onClick={() => onSave({
          id, adapterId, enabled: initial?.enabled ?? true, ...(label.trim() ? { label: label.trim() } : {}),
          credentials: Object.fromEntries(Object.entries(credentials).filter(([key, v]) => v.trim() && fields.some((f) => f.key === key)).map(([k, v]) => [k, v.trim()]))
        })}>
          {t("imSettings.save")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

function Countdown({ until }: { until: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const left = Math.max(0, Math.round((until - Date.now()) / 1000));
  return <>{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}</>;
}

/** Pair yourself from a direct message, and the people already paired. */
function People({ connection, im, pairing, defaultProject, onError }: {
  connection: ImConnectionView; im: ImSettings; pairing?: ImPairingView; defaultProject: string; onError: (e: string) => void;
}) {
  const { t } = useI18n();
  const [projectId, setProjectId] = useState(defaultProject);
  const start = useImPairStart();
  const confirm = useImPairConfirm();
  const cancel = useImPairCancel();
  const revoke = useImRevoke();
  const paired = im.identities.filter((i) => i.connectionId === connection.id);
  useEffect(() => { if (!projectId && defaultProject) setProjectId(defaultProject); }, [defaultProject, projectId]);
  const fail = { onError: (e: Error) => onError(messageOf(e)) };
  return (
    <div className="stack-2" data-testid="im-people">
      <div className="eyebrow">{t("imSettings.pairing")}</div>
      {paired.length ? paired.map((i) => (
        <div className="cfg-row" key={`${i.tenantId}:${i.actorId}`}>
          <Icon name="i-check" size={13} style={{ color: "var(--accent)" }} />
          <div className="cfg-name">{i.name ?? i.actorId}<div className="meta-txt dense mono">{i.actorId}</div></div>
          <button type="button" className="btn btn-ghost" onClick={() => revoke.mutate([connection.id, i.tenantId, i.actorId], fail)}>{t("imSettings.revoke")}</button>
        </div>
      )) : <p className="meta-txt dense">{t("imSettings.noPaired")}</p>}
      {pairing?.claim ? (
        <div className="panel row" style={{ gap: 8, flexWrap: "wrap" }} role="status">
          <span>{t("imSettings.pairClaim", { name: pairing.claim.name ? `${pairing.claim.name} (${pairing.claim.actorId})` : pairing.claim.actorId })}</span>
          <button type="button" className="btn btn-secondary" onClick={() => confirm.mutate([connection.id], fail)} data-testid="im-pair-confirm">{t("imSettings.pairConfirm")}</button>
          <button type="button" className="btn btn-ghost" onClick={() => cancel.mutate([connection.id], fail)}>{t("imSettings.pairReject")}</button>
        </div>
      ) : pairing ? (
        <div className="panel stack-2" role="status" data-testid="im-pair-code">
          <span className="meta-txt">{t("imSettings.pairCode")}</span>
          <span className="mono" style={{ fontSize: 18, userSelect: "all" }}>/pair {pairing.code}</span>
          <span className="meta-txt">{t("imSettings.pairExpires", { time: "" })}<Countdown until={pairing.expiresAt} /> · {t("imSettings.pairWaiting")}</span>
          <button type="button" className="btn btn-ghost" style={{ alignSelf: "flex-start" }} onClick={() => cancel.mutate([connection.id], fail)}>{t("common.cancel")}</button>
        </div>
      ) : connection.state === "connected" ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor={`im-pair-project-${connection.id}`}>{t("imSettings.pairProject")}</label>
            <ProjectSelect id={`im-pair-project-${connection.id}`} value={projectId} onChange={setProjectId} />
          </div>
          <button type="button" className="btn btn-secondary" disabled={!projectId} onClick={() => start.mutate([connection.id, projectId], fail)} data-testid="im-pair-start">
            {t("imSettings.pairStart")}
          </button>
          <span className="meta-txt">{t("imSettings.pairHelp")}</span>
        </div>
      ) : null}
    </div>
  );
}

function RouteRow({ route, names, onChange, onRemove }: { route: ImRoute; names: Map<string, string>; onChange: (next: ImRoute) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const engines = useEngines();
  const engine = (engines.data ?? []).find((e) => e.id === route.engine);
  const set = (patch: Partial<ImRoute>) => onChange({ ...route, ...patch });
  const id = (key: string) => `im-route-${route.id}-${key}`;
  return (
    <div className="panel stack-2" data-im-route={route.id}>
      <div className="row" style={{ gap: 8 }}>
        <Tag tone="faint">{route.allowGroups && !route.allowDirectMessages ? t("imSettings.group") : t("imSettings.dm")}</Tag>
        <span className="mono meta-txt" style={{ flex: 1 }}>{route.conversationId}</span>
        <button type="button" className="btn btn-ghost" onClick={onRemove}>{t("imSettings.removeRoute")}</button>
      </div>
      <div className="grid-2">
        <div className="field">
          <label htmlFor={id("project")}>{t("imSettings.project")}</label>
          <ProjectSelect id={id("project")} value={route.projectId} onChange={(projectId) => set({ projectId, boardId: null })} />
        </div>
        <div className="field">
          <label htmlFor={id("engine")}>{t("imSettings.engine")}</label>
          <select id={id("engine")} className="input" value={route.engine ?? ""} onChange={(e) => set({ engine: e.target.value || undefined, options: undefined, permissionMode: undefined })}>
            <option value="">{t("imSettings.engineDefault")}</option>
            {(engines.data ?? []).filter((e) => e.ok || e.id === route.engine).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
          </select>
        </div>
        {(engine?.picks ?? []).map((pick) => (
          <div className="field" key={pick.key}>
            <label htmlFor={id(`pick-${pick.key}`)}>{pick.title}</label>
            <select id={id(`pick-${pick.key}`)} className="input" value={String(route.options?.[pick.key] ?? "")} onChange={(e) => {
              const { [pick.key]: _old, ...rest } = route.options ?? {};
              const options = e.target.value ? { ...rest, [pick.key]: e.target.value } : rest;
              set({ options: Object.keys(options).length ? options : undefined });
            }}>
              <option value="">{t("imSettings.optionDefault")}</option>
              {pick.choices.map((c) => <option key={c.value} value={c.value}>{c.label ?? c.value}</option>)}
            </select>
          </div>
        ))}
        {engine?.permissionModes && (
          <div className="field">
            <label htmlFor={id("mode")}>{t("imSettings.mode")}</label>
            <select id={id("mode")} className="input" value={route.permissionMode ?? ""} onChange={(e) => set({ permissionMode: e.target.value || undefined })}>
              <option value="">{t("imSettings.optionDefault")}</option>
              {engine.permissionModes.choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor={id("activation")}>{t("imSettings.activation")}</label>
          <select id={id("activation")} className="input" value={route.groupActivation} disabled={!route.allowGroups} onChange={(e) => set({ groupActivation: e.target.value as ImRoute["groupActivation"] })}>
            <option value="mention">{t("imSettings.activationMention")}</option>
            <option value="reply">{t("imSettings.activationReply")}</option>
            <option value="all">{t("imSettings.activationAll")}</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={id("output")}>{t("imSettings.output")}</label>
          <select id={id("output")} className="input" value={route.output} onChange={(e) => set({ output: e.target.value as ImRoute["output"] })}>
            <option value="progress">{t("imSettings.outputProgress")}</option>
            <option value="final">{t("imSettings.outputFinal")}</option>
            <option value="verbose">{t("imSettings.outputVerbose")}</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
        {([["allowDirectMessages", "imSettings.allowDirect"], ["allowGroups", "imSettings.allowGroups"]] as const).map(([key, label]) => (
          <label key={key} className="row" style={{ gap: 6 }}>
            <button type="button" className="switch" role="switch" aria-checked={route[key]} aria-label={t(label)} onClick={() => set({ [key]: !route[key] })} />
            {t(label)}
          </label>
        ))}
      </div>
      <div className="field">
        <label>{t("imSettings.people")}</label>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          {route.allowedActors.map((actor) => (
            <span key={actor} className="row" style={{ gap: 2 }}>
              <Tag tone="neutral">{names.get(actor) ?? actor}</Tag>
              {route.allowedActors.length > 1 && (
                <button type="button" className="icon-btn" aria-label={t("imSettings.removePerson", { name: names.get(actor) ?? actor })}
                  onClick={() => set({ allowedActors: route.allowedActors.filter((a) => a !== actor) })}>
                  <Icon name="i-close" size={11} />
                </button>
              )}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function ConnectionCard({ view, adapter, im, pairing, defaultProject, busy, onEdit, onToggle, onRemove, onRoutes, onError }: {
  view: ImConnectionView; adapter?: ImAdapterView; im: ImSettings; pairing?: ImPairingView; defaultProject: string; busy: boolean;
  onEdit: () => void; onToggle: () => void; onRemove: () => void; onRoutes: (routes: ImRoute[]) => void; onError: (e: string) => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const spec = im.connections.find((c) => c.id === view.id);
  const name = view.label ?? view.id;
  const routes = im.routes.filter((r) => r.connectionId === view.id);
  const names = new Map(im.identities.filter((i) => i.connectionId === view.id && i.name).map((i) => [i.actorId, i.name!]));
  const fieldLabel = (key: string) => adapter?.setup?.fields.find((f) => f.key === key)?.label ?? key;
  const detail = view.identity ? t("imSettings.signedInAs", { name: view.identity.name ?? view.identity.id })
    : !adapter ? t("imSettings.noAdapter")
    : view.missing.length ? t("imSettings.missing", { fields: view.missing.map(fieldLabel).join(", ") })
    : view.detail ?? "";
  return (
    <div className="stack-3" data-im-connection={view.id} data-state={view.state}>
      <div className={cn("cfg-row", !spec?.enabled && "off")}>
        <Icon name="i-send" size={15} style={{ color: view.state === "error" ? "var(--danger)" : view.state === "connected" ? "var(--accent)" : "var(--meta)" }} />
        <div className="cfg-name">
          {name}
          <div className="meta-txt dense">{adapter?.title ?? view.adapterId}</div>
          <div className="meta-txt dense" style={view.state === "error" ? { color: "var(--danger)" } : undefined}>{detail}</div>
          {(view.pending + view.uncertain + view.failed) > 0 && <div className="meta-txt dense">{t("imSettings.counts", { pending: view.pending, uncertain: view.uncertain, failed: view.failed })}</div>}
        </div>
        <Tag tone={view.state === "connected" ? "strong" : view.state === "unconfigured" ? "faint" : "neutral"}>{t(STATE_KEY[view.state])}</Tag>
        <button type="button" className="icon-btn" aria-label={t("imSettings.edit")} title={t("imSettings.edit")} disabled={!adapter} onClick={onEdit}>
          <Icon name="i-pen" size={14} />
        </button>
        {confirming ? (
          <button type="button" className="btn btn-danger" onClick={onRemove} onBlur={() => setConfirming(false)} autoFocus>{t("imSettings.confirmRemove", { name })}</button>
        ) : (
          <button type="button" className="icon-btn danger" aria-label={t("imSettings.remove")} title={t("imSettings.remove")} onClick={() => setConfirming(true)}>
            <Icon name="i-trash" size={14} />
          </button>
        )}
        <button type="button" className="switch" role="switch" aria-checked={!!spec?.enabled} aria-label={t("imSettings.enableAria", { name })} disabled={busy} onClick={onToggle} />
      </div>
      <div className="stack-3" style={{ paddingLeft: 24 }}>
        <People connection={view} im={im} pairing={pairing} defaultProject={defaultProject} onError={onError} />
        <div className="stack-2">
          <div className="eyebrow">{t("imSettings.routes")}</div>
          {routes.length ? routes.map((route) => (
            <RouteRow key={route.id} route={route} names={names}
              onChange={(next) => onRoutes(im.routes.map((r) => (r.id === route.id ? next : r)))}
              onRemove={() => onRoutes(im.routes.filter((r) => r.id !== route.id))} />
          )) : <p className="meta-txt dense">{t("imSettings.noRoutes")}</p>}
        </div>
      </div>
    </div>
  );
}

function Ignored({ im, defaultProject, onError }: { im: ImSettings; defaultProject: string; onError: (e: string) => void }) {
  const { t, locale } = useI18n();
  const ignored = useImIgnored();
  const allow = useImAllow();
  const [projectId, setProjectId] = useState(defaultProject);
  useEffect(() => { if (!projectId && defaultProject) setProjectId(defaultProject); }, [defaultProject, projectId]);
  const rows = ignored.data ?? [];
  const time = (at: number) => new Date(at).toLocaleTimeString(locale === "zh" ? "zh-CN" : "en-US", { hour: "2-digit", minute: "2-digit" });
  const routed = (row: ImIgnoredView) => im.routes.some((r) => r.connectionId === row.connectionId && r.tenantId === row.tenantId && r.conversationId === row.conversationId);
  const go = (row: ImIgnoredView, scope: "person" | "group") =>
    allow.mutate([{ ignoredId: row.id, scope, ...(routed(row) ? {} : { projectId }) }], { onError: (e) => onError(messageOf(e)) });
  return (
    <div className="stack-2" data-testid="im-ignored">
      <SectionHead title={t("imSettings.ignored")}>{t("imSettings.ignoredHelp")}</SectionHead>
      {rows.some((row) => !routed(row)) && (
        <div className="field" style={{ maxWidth: 280 }}>
          <label htmlFor="im-new-project">{t("imSettings.newProject")}</label>
          <ProjectSelect id="im-new-project" value={projectId} onChange={setProjectId} />
        </div>
      )}
      {rows.length ? rows.map((row) => (
        <div className="cfg-row" key={row.id} data-im-ignored={row.id}>
          <span className="meta-txt mono">{time(row.at)}</span>
          <div className="cfg-name">
            {row.actorName ? `${row.actorName} · ` : ""}<span className="mono">{row.actorId}</span>
            <div className="meta-txt dense">{row.group ? t("imSettings.group") : t("imSettings.dm")} · <span className="mono">{row.conversationId}</span> · {t(REASON_KEY[row.reason])}</div>
          </div>
          {row.reason !== "bot" && (
            <>
              <button type="button" className="btn btn-ghost" disabled={allow.isPending || (!routed(row) && !projectId)} onClick={() => go(row, "person")}>{t("imSettings.allowPerson")}</button>
              {row.group && <button type="button" className="btn btn-ghost" disabled={allow.isPending || (!routed(row) && !projectId)} onClick={() => go(row, "group")}>{t("imSettings.allowGroup")}</button>}
            </>
          )}
        </div>
      )) : <p className="meta-txt dense">{t("imSettings.noIgnored")}</p>}
    </div>
  );
}

function Deliveries({ onError }: { onError: (e: string) => void }) {
  const { t } = useI18n();
  const deliveries = useImDeliveries();
  const retry = useImRetry();
  const discard = useImDiscard();
  const rows = deliveries.data ?? [];
  const fail = { onError: (e: Error) => onError(messageOf(e)) };
  return (
    <div className="stack-2" data-testid="im-deliveries">
      <SectionHead title={t("imSettings.deliveries")}>{t("imSettings.deliveriesHelp")}</SectionHead>
      {rows.length ? rows.map((row) => (
        <div className="cfg-row" key={row.id} data-im-delivery={row.id}>
          <Tag tone={row.state === "failed" ? "strong" : "neutral"}>{row.state === "failed" ? t("imSettings.failed") : t("imSettings.uncertain")}</Tag>
          <div className="cfg-name">
            <div className="mcp-oneline">{row.preview}</div>
            <div className="meta-txt dense"><span className="mono">{row.connectionId} · {row.conversationId}</span>{row.error ? ` · ${row.error}` : ""}</div>
          </div>
          <button type="button" className="btn btn-ghost" disabled={retry.isPending} onClick={() => retry.mutate([row.id], fail)}>{t("imSettings.retry")}</button>
          <button type="button" className="btn btn-ghost" disabled={discard.isPending} onClick={() => discard.mutate([row.id], fail)}>{t("imSettings.discard")}</button>
        </div>
      )) : <p className="meta-txt dense">{t("imSettings.noDeliveries")}</p>}
    </div>
  );
}

/**
 * IM without JSON: bots and their credentials, pairing, the conversations
 * each project answers, and what was ignored or got stuck. Configuration lives
 * in the `im` settings section; live state comes from the IM service.
 */
export function ImPane({ scopeTag }: { scopeTag?: React.ReactNode }) {
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSaveSettings();
  const views = useImConnections();
  const adapters = useImAdapters();
  const pairings = useImPairings();
  const projects = useProjects();
  const storage = useSecretStorage();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const im = (settings.data?.im as ImSettings | undefined) ?? EMPTY;
  const connected = (views.data ?? []).filter((v) => v.state === "connected").length;
  const defaultProject = (projects.data ?? []).find((p) => !p.archived)?.id ?? "";
  const plaintext = storage.data === "plaintext";
  const persist = (next: ImSettings, done?: () => void) => {
    if (!settings.data) return;
    setError(null);
    save.mutate({ ...settings.data, im: next }, { onSuccess: () => done?.(), onError: (e) => setError(messageOf(e)) });
  };
  const installed = adapters.data ?? [];

  return (
    <>
      <SectionHead title={t("imSettings.label")} aside={<>{scopeTag}<Tag tone="neutral">{t("imSettings.connectedOfTotal", { connected, total: im.connections.length })}</Tag></>}>
        {t("imSettings.lede")}
      </SectionHead>
      <p className="meta-txt" data-testid="im-secret-storage" style={plaintext ? { color: "var(--warn)" } : undefined}>
        <Icon name={plaintext ? "i-warn" : "i-lock"} size={12} style={{ display: "inline", verticalAlign: "-1px" }} /> {plaintext ? t("imSettings.plaintext") : t("imSettings.keychain")}
      </p>
      <div className="stack-4">
        <div className="stack-3">
          {(views.data ?? []).map((view) =>
            editing === view.id ? (
              <ConnectionForm key={view.id} adapters={installed} initial={im.connections.find((c) => c.id === view.id)} taken={[]} plaintext={plaintext} busy={save.isPending}
                onSave={(connection) => persist({ ...im, connections: im.connections.map((c) => (c.id === view.id ? connection : c)) }, () => setEditing(null))}
                onCancel={() => setEditing(null)} />
            ) : (
              <ConnectionCard key={view.id} view={view} adapter={installed.find((a) => a.id === view.adapterId)} im={im} pairing={(pairings.data ?? []).find((p) => p.connectionId === view.id)}
                defaultProject={defaultProject} busy={save.isPending} onError={setError}
                onEdit={() => setEditing(view.id)}
                onToggle={() => persist({ ...im, connections: im.connections.map((c) => (c.id === view.id ? { ...c, enabled: !c.enabled } : c)) })}
                onRemove={() => persist({ connections: im.connections.filter((c) => c.id !== view.id), identities: im.identities.filter((i) => i.connectionId !== view.id), routes: im.routes.filter((r) => r.connectionId !== view.id) })}
                onRoutes={(routes) => persist({ ...im, routes })} />
            )
          )}
          {!im.connections.length && editing !== "" && <p className="meta-txt">{installed.length ? t("imSettings.empty") : t("imSettings.noAdapters")}</p>}
          {editing === "" && (
            <ConnectionForm adapters={installed} taken={im.connections.map((c) => c.id)} plaintext={plaintext} busy={save.isPending}
              onSave={(connection) => persist({ ...im, connections: [...im.connections, connection] }, () => setEditing(null))}
              onCancel={() => setEditing(null)} />
          )}
          {editing === null && installed.length > 0 && (
            <button type="button" className="btn btn-secondary" style={{ alignSelf: "flex-start" }} onClick={() => setEditing("")} data-testid="im-add">
              <Icon name="i-plus" size={13} /> {t("imSettings.add")}
            </button>
          )}
          {error && <p className="meta-txt dense" role="alert" style={{ color: "var(--danger)" }}>{error}</p>}
        </div>
        <Ignored im={im} defaultProject={defaultProject} onError={setError} />
        <Deliveries onError={setError} />
      </div>
    </>
  );
}
