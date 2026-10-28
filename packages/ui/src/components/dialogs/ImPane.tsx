import { useEffect, useState } from "react";
import type { ImAdapterView, ImConnectionView, ImIgnoredView, ImNotifyKind, ImPairingView, ImRoute, ImSettings } from "@tomradex/im";
import { GROUP_PRESETS, presetOf, type GroupPreset } from "@tomradex/im/presets";
import { Icon, type IconId } from "~/components/icons";
import { FoldChevron, SectionHead, Tag } from "~/components/ui/atoms";
import { useEngines } from "~/lib/agent";
import { intlTag, useI18n, type MessageKey } from "~/lib/i18n";
import {
  useImAdapters, useImAllow, useImClearContext, useImConnections, useImDeliveries, useImDiscard, useImIgnored,
  useImPairCancel, useImPairConfirm, useImPairings, useImPairStart, useImRetry, useImRevoke
} from "~/lib/im";
import { usePanelOpen } from "~/lib/panel";
import { useProjects, useSaveSettings, useSecretStorage, useSettings } from "~/lib/queries";
import { cn } from "~/lib/utils";
import { readableError } from "~/lib/toast";

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const SHARED: ImSettings["notify"] = { tickets: true, code: true, presence: false, routines: false, attention: true };
const EMPTY: ImSettings = { connections: [], identities: [], routes: [], notify: SHARED };

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
  const [adding, setAdding] = useState(false);
  const start = useImPairStart();
  const confirm = useImPairConfirm();
  const cancel = useImPairCancel();
  const revoke = useImRevoke();
  const paired = im.identities.filter((i) => i.connectionId === connection.id);
  useEffect(() => { if (!projectId && defaultProject) setProjectId(defaultProject); }, [defaultProject, projectId]);
  const fail = { onError: (e: Error) => onError(readableError(e)) };
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
      ) : connection.state === "connected" && !adding ? (
        <button type="button" className="btn btn-secondary" style={{ alignSelf: "flex-start" }} onClick={() => setAdding(true)} data-testid="im-pair-add">
          <Icon name="i-plus" size={13} /> {t("imSettings.pairAdd")}
        </button>
      ) : connection.state === "connected" ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="field" style={{ minWidth: 180 }}>
            <label htmlFor={`im-pair-project-${connection.id}`}>{t("imSettings.pairProject")}</label>
            <ProjectSelect id={`im-pair-project-${connection.id}`} value={projectId} onChange={setProjectId} />
          </div>
          <button type="button" className="btn btn-secondary" disabled={!projectId} onClick={() => start.mutate([connection.id, projectId], fail)} data-testid="im-pair-start">
            {t("imSettings.pairStart")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>{t("common.cancel")}</button>
          <span className="meta-txt">{t("imSettings.pairHelp")}</span>
        </div>
      ) : null}
    </div>
  );
}

const NOTIFY: readonly (readonly [ImNotifyKind, MessageKey, MessageKey, IconId])[] = [
  ["tickets", "imSettings.notifyTickets", "imSettings.notifyTicketsHelp", "i-board"],
  ["code", "imSettings.notifyCode", "imSettings.notifyCodeHelp", "i-branch"],
  ["presence", "imSettings.notifyPresence", "imSettings.notifyPresenceHelp", "i-monitor"],
  ["routines", "imSettings.notifyRoutines", "imSettings.notifyRoutinesHelp", "i-calendar"],
  ["attention", "imSettings.notifyAttention", "imSettings.notifyAttentionHelp", "i-alarm"]
];

/** What every conversation hears, one switch per kind; a route may answer for itself. */
function SharedNotify({ notify, busy, onChange }: { notify: ImSettings["notify"]; busy: boolean; onChange: (next: ImSettings["notify"]) => void }) {
  const { t } = useI18n();
  // Defaults change rarely: one line saying what is on, the switches once opened.
  const [open, setOpen] = useState(false);
  const on = NOTIFY.filter(([key]) => notify[key]).map(([, label]) => t(label));
  return (
    <div className="stack-2" data-testid="im-notify">
      <div className="fold-row">
        <FoldChevron open={open} label={t(open ? "imSettings.foldBot" : "imSettings.unfoldBot", { name: t("imSettings.notifyShared") })} onToggle={() => setOpen(!open)} testId="im-notify-fold" />
        <SectionHead title={t("imSettings.notifyShared")}>{t("imSettings.notifySharedHelp")}</SectionHead>
      </div>
      {!open && <p className="meta-txt dense fold-row-body" data-testid="im-notify-summary">{on.length ? t("imSettings.notifyOn", { kinds: on.join(t("imSettings.listSep")) }) : t("imSettings.notifyNone")}</p>}
      {open && NOTIFY.map(([key, label, help, icon]) => (
        <div key={key} className={cn("cfg-row", !notify[key] && "off")} data-im-notify-kind={key}>
          <Icon name={icon} size={15} style={{ color: notify[key] ? "var(--accent)" : "var(--meta)" }} />
          <div className="cfg-name">
            {t(label)}
            <div className="meta-txt dense">{t(help)}</div>
          </div>
          <button type="button" className="switch" role="switch" aria-checked={notify[key]} aria-label={t(label)} disabled={busy}
            onClick={() => onChange({ ...notify, [key]: !notify[key] })} />
        </div>
      ))}
    </div>
  );
}

const PURPOSES: readonly (readonly [GroupPreset, MessageKey])[] = [
  ["work", "imSettings.purposeWork"], ["status", "imSettings.purposeStatus"], ["chat", "imSettings.purposeChat"]
];
const ROLE: Record<GroupPreset, MessageKey> = { work: "imSettings.roleWork", status: "imSettings.roleStatus", chat: "imSettings.roleChat" };

/** A conversation as one line, its project, assistant and what it hears once opened. */
function RouteRow({ route, names, shared, onChange, onRemove }: { route: ImRoute; names: Map<string, string>; shared: ImSettings["notify"]; onChange: (next: ImRoute) => void; onRemove: () => void }) {
  const { t } = useI18n();
  const engines = useEngines();
  const projects = useProjects();
  const engine = (engines.data ?? []).find((e) => e.id === route.engine);
  const set = (patch: Partial<ImRoute>) => onChange({ ...route, ...patch });
  const id = (key: string) => `im-route-${route.id}-${key}`;
  const clear = useImClearContext();
  const [cleared, setCleared] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  // "Custom" stays chosen while its switches still match a preset, until the person picks one.
  const [customizing, setCustomizing] = useState(false);
  const windowed = { enabled: false, messages: 20, retentionHours: 24, ...route.groupContext };
  const setWindow = (patch: Partial<typeof windowed>) => set({ groupContext: { ...windowed, ...patch } });
  const custom = Object.keys(route.notify ?? {}).length > 0;
  const notify = { ...shared, ...route.notify };
  const group = (route.kind ?? (route.allowGroups && !route.allowDirectMessages ? "group" : "dm")) === "group";
  const preset = route.kind === "group" && !customizing ? presetOf(route) : null;
  // A conversation whose kind is known has one switch: whether it is let in at all.
  const enabledKey = route.kind === "group" ? "allowGroups" : route.kind === "dm" ? "allowDirectMessages" : null;
  const on = enabledKey ? route[enabledKey] : route.allowDirectMessages || route.allowGroups;
  const project = (projects.data ?? []).find((p) => p.id === route.projectId)?.name ?? route.projectId;
  const summary = group
    ? [route.kind === "group" ? t(preset ? ROLE[preset] : "imSettings.roleCustom") : null, project, t("imSettings.peopleCount", { n: route.allowedActors.length })]
    : [project, engine?.title ?? t("imSettings.engineDefault")];
  const choose = (value: string) => {
    if (value === "custom") { setCustomizing(true); return; }
    setCustomizing(false);
    const { notify: presetNotify, ...fields } = GROUP_PRESETS[value as GroupPreset];
    set({ ...fields, notify: { ...presetNotify } });
  };
  // Today's switches, where a purpose does not stand for them.
  const switches = ([["allowDirectMessages", "imSettings.allowDirect", "dm"], ["allowGroups", "imSettings.allowGroups", "group"], ["desktopTurns", "imSettings.desktopTurns", "dm"]] as const)
    .filter(([key, , applies]) => (!route.kind || route.kind === applies) && key !== enabledKey);
  const detailed = route.kind !== "group" || !preset;
  // A direct chat goes by the person in it, a group by the name the platform gave it; the id stays a tooltip.
  const named = (route.kind === "dm" ? names.get(route.allowedActors[0] ?? "") : undefined) ?? route.label;
  const shown = named ?? route.conversationId;
  return (
    <div className="stack-2" data-im-route={route.id}>
      <div className="fold-row">
        <FoldChevron open={open} label={t(open ? "imSettings.foldBot" : "imSettings.unfoldBot", { name: shown })} onToggle={() => setOpen(!open)} testId="im-route-fold" />
        <div className={cn("cfg-row", !on && "off")}>
          <Tag tone="faint">{group ? t("imSettings.group") : t("imSettings.dm")}</Tag>
          <div className="cfg-name">
            <span className={cn(!named && "mono")} title={route.conversationId} data-testid="im-route-name">{shown}</span>
            <div className="meta-txt dense" data-testid="im-route-summary">{summary.filter(Boolean).join(" · ")}</div>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onRemove}>{t("imSettings.removeRoute")}</button>
          {enabledKey && (
            <button type="button" className="switch" role="switch" aria-checked={on} aria-label={t("imSettings.routeEnabled", { name: shown })}
              onClick={() => set({ [enabledKey]: !on })} data-testid="im-route-on" />
          )}
        </div>
      </div>
      {open && (
        <div className="fold-row-body">
          <div className="panel stack-2">
            <div className="grid-2">
              <div className="field">
                <label htmlFor={id("project")}>{t("imSettings.project")}</label>
                <ProjectSelect id={id("project")} value={route.projectId} onChange={(projectId) => set({ projectId, boardId: null })} />
              </div>
              <div className="field">
                <label htmlFor={id("engine")}>{t("imSettings.engine")}</label>
                <select id={id("engine")} className="input" value={route.engine ?? ""} onChange={(e) => set({ engine: e.target.value || undefined, options: undefined, permissionMode: undefined })}>
                  <option value="">{t("imSettings.engineDefault")}</option>
                  {(engines.data ?? []).filter((e) => (e.ok && !e.terminalOnly) || e.id === route.engine).map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
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
              {route.kind === "group" && (
                <div className="field">
                  <label htmlFor={id("purpose")}>{t("imSettings.purpose")}</label>
                  <select id={id("purpose")} className="input" value={preset ?? "custom"} onChange={(e) => choose(e.target.value)}>
                    {PURPOSES.map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}
                    <option value="custom">{t("imSettings.purposeCustom")}</option>
                  </select>
                </div>
              )}
              {route.kind !== "dm" && detailed && (
                <div className="field">
                  <label htmlFor={id("activation")}>{t("imSettings.activation")}</label>
                  <select id={id("activation")} className="input" value={route.groupActivation} disabled={!route.allowGroups} onChange={(e) => set({ groupActivation: e.target.value as ImRoute["groupActivation"] })}>
                    <option value="mention">{t("imSettings.activationMention")}</option>
                    <option value="reply">{t("imSettings.activationReply")}</option>
                    <option value="all">{t("imSettings.activationAll")}</option>
                  </select>
                </div>
              )}
              <div className="field">
                <label htmlFor={id("output")}>{t("imSettings.output")}</label>
                <select id={id("output")} className="input" value={route.output} onChange={(e) => set({ output: e.target.value as ImRoute["output"] })}>
                  <option value="progress">{t("imSettings.outputProgress")}</option>
                  <option value="final">{t("imSettings.outputFinal")}</option>
                  <option value="verbose">{t("imSettings.outputVerbose")}</option>
                </select>
              </div>
            </div>
            {switches.length > 0 && (
              <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                {switches.map(([key, label]) => (
                  <label key={key} className="row" style={{ gap: 6 }}>
                    <button type="button" className="switch" role="switch" aria-checked={route[key]} aria-label={t(label)} onClick={() => set({ [key]: !route[key] })} />
                    {t(label)}
                  </label>
                ))}
              </div>
            )}
            {detailed && (
              <div className="stack-2" data-im-notify={route.id}>
                <label className="row" style={{ gap: 6 }}>
                  <button type="button" className="switch" role="switch" aria-checked={!custom} aria-label={t("imSettings.notifyFollow")}
                    onClick={() => set({ notify: custom ? undefined : { ...notify } })} />
                  {t("imSettings.notifyFollow")}
                </label>
                {custom && (
                  <>
                    <div className="eyebrow">{t("imSettings.notify")}</div>
                    <div className="row" style={{ gap: 16, flexWrap: "wrap" }}>
                      {NOTIFY.map(([key, label]) => (
                        <label key={key} className="row" style={{ gap: 6 }}>
                          <button type="button" className="switch" role="switch" aria-checked={notify[key]} aria-label={t(label)} onClick={() => set({ notify: { ...notify, [key]: !notify[key] } })} />
                          {t(label)}
                        </label>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
            {route.allowGroups && route.kind !== "dm" && detailed && (
              <div className="stack-2" data-im-ticket-topics={route.id}>
                <label className="row" style={{ gap: 6 }}>
                  <button type="button" className="switch" role="switch" aria-checked={route.ticketTopics !== false} aria-label={t("imSettings.ticketTopics")}
                    onClick={() => set({ ticketTopics: route.ticketTopics === false })} />
                  {t("imSettings.ticketTopics")}
                </label>
                <p className="meta-txt dense">{t("imSettings.ticketTopicsHelp")}</p>
              </div>
            )}
            {route.allowGroups && route.kind !== "dm" && (
              <div className="stack-2" data-im-group-context={route.id}>
                <label className="row" style={{ gap: 6 }}>
                  <button type="button" className="switch" role="switch" aria-checked={windowed.enabled} aria-label={t("imSettings.groupContext")} onClick={() => setWindow({ enabled: !windowed.enabled })} />
                  {t("imSettings.groupContext")}
                </label>
                <p className="meta-txt dense">{t("imSettings.groupContextHelp")}</p>
                {windowed.enabled && (
                  <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div className="field">
                      <label htmlFor={id("window-messages")}>{t("imSettings.groupContextMessages")}</label>
                      <input id={id("window-messages")} className="input num" type="number" min={1} max={100} value={windowed.messages}
                        onChange={(e) => setWindow({ messages: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />
                    </div>
                    <div className="field">
                      <label htmlFor={id("window-hours")}>{t("imSettings.groupContextHours")}</label>
                      <input id={id("window-hours")} className="input num" type="number" min={1} max={720} value={windowed.retentionHours}
                        onChange={(e) => setWindow({ retentionHours: Math.min(720, Math.max(1, Number(e.target.value) || 1)) })} />
                    </div>
                    <button type="button" className="btn btn-secondary" disabled={clear.isPending}
                      onClick={() => clear.mutate([route.id], { onSuccess: (n) => setCleared(n) })}>
                      {t("imSettings.groupContextClear")}
                    </button>
                    {cleared !== null && <span className="meta-txt">{t("imSettings.groupContextCleared", { n: cleared })}</span>}
                  </div>
                )}
              </div>
            )}
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
        </div>
      )}
    </div>
  );
}

function ConnectionCard({ view, adapter, im, pairing, defaultProject, busy, onEdit, onToggle, onRemove, onRoutes, onError }: {
  view: ImConnectionView; adapter?: ImAdapterView; im: ImSettings; pairing?: ImPairingView; defaultProject: string; busy: boolean;
  onEdit: () => void; onToggle: () => void; onRemove: () => void; onRoutes: (routes: ImRoute[]) => void; onError: (e: string) => void;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);
  const [stored, setOpen] = usePanelOpen(`tomrade.im.bot.${view.id}`);
  // A pairing under way stays in sight: its code and the claim to confirm live inside.
  const open = stored || !!pairing;
  const spec = im.connections.find((c) => c.id === view.id);
  const name = view.label ?? view.id;
  const routes = im.routes.filter((r) => r.connectionId === view.id);
  const paired = im.identities.filter((i) => i.connectionId === view.id);
  const names = new Map(paired.filter((i) => i.name).map((i) => [i.actorId, i.name!]));
  const fieldLabel = (key: string) => adapter?.setup?.fields.find((f) => f.key === key)?.label ?? key;
  const detail = view.identity ? t("imSettings.signedInAs", { name: view.identity.name ?? view.identity.id })
    : !adapter ? t("imSettings.noAdapter")
    : view.missing.length ? t("imSettings.missing", { fields: view.missing.map(fieldLabel).join(", ") })
    : view.detail ?? "";
  return (
    <div className="stack-3" data-im-connection={view.id} data-state={view.state}>
      <div className="fold-row">
        <FoldChevron open={open} label={t(open ? "imSettings.foldBot" : "imSettings.unfoldBot", { name })} disabled={!!pairing} onToggle={() => setOpen(!stored)} testId="im-fold" />
        <div className={cn("cfg-row", !spec?.enabled && "off")}>
          <Icon name="i-send" size={15} style={{ color: view.state === "error" ? "var(--danger)" : view.state === "connected" ? "var(--accent)" : "var(--meta)" }} />
          <div className="cfg-name">
            {name}
            <div className="meta-txt dense">{adapter?.title ?? view.adapterId}</div>
            <div className="meta-txt dense" style={view.state === "error" ? { color: "var(--danger)" } : undefined}>{detail}</div>
            {view.links?.map((l) => <a key={l.url} className="meta-txt dense" href={l.url} target="_blank" rel="noreferrer" data-testid="im-link">{l.label}</a>)}
            {view.notices?.map((n) => (
              <div key={n.key} className="meta-txt dense" style={{ color: "var(--danger)" }} data-testid="im-notice">
                {n.text}{n.link && <> · <a href={n.link.url} target="_blank" rel="noreferrer">{n.link.label}</a></>}
              </div>
            ))}
            {(view.pending + view.uncertain + view.failed) > 0 && <div className="meta-txt dense">{t("imSettings.counts", { pending: view.pending, uncertain: view.uncertain, failed: view.failed })}</div>}
            {!open && <div className="meta-txt dense" data-testid="im-folded-summary">{t("imSettings.foldedSummary", { routes: routes.length, people: paired.length })}</div>}
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
      </div>
      {open && (
        <div className="stack-3 fold-row-body">
          <People connection={view} im={im} pairing={pairing} defaultProject={defaultProject} onError={onError} />
          {view.state === "connected" && <GroupGuide adapter={adapter} routes={routes} />}
          <div className="stack-2">
            <div className="eyebrow">{t("imSettings.routes")}</div>
            {routes.length ? routes.map((route) => (
              <RouteRow key={route.id} route={route} names={names} shared={im.notify ?? SHARED}
                onChange={(next) => onRoutes(im.routes.map((r) => (r.id === route.id ? next : r)))}
                onRemove={() => onRoutes(im.routes.filter((r) => r.id !== route.id))} />
            )) : <p className="meta-txt dense">{t("imSettings.noRoutes")}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

/** What a group or server channel is for: its preset, else what its switches make it. */
function roleOf(route: ImRoute): MessageKey {
  const preset = presetOf(route);
  return preset ? ROLE[preset] : "imSettings.roleCustom";
}

/** How to bring the connected bot into a group or server, open by itself until it is in one, and which channels already hear what. */
function GroupGuide({ adapter, routes }: { adapter?: ImAdapterView; routes: ImRoute[] }) {
  const { t } = useI18n();
  const groups = routes.filter((r) => r.allowGroups && r.kind !== "dm");
  const [open, setOpen] = useState(!groups.length);
  const steps = adapter?.setup?.groupSteps?.length ? adapter.setup.groupSteps : [t("imSettings.groupStepAdd"), t("imSettings.groupStepMention")];
  return (
    <div className="stack-2" data-testid="im-group-guide">
      <div className="fold-row">
        <FoldChevron open={open} label={t(open ? "imSettings.foldBot" : "imSettings.unfoldBot", { name: t("imSettings.groupGuide") })} onToggle={() => setOpen(!open)} testId="im-group-guide-fold" />
        <div className="eyebrow">{t("imSettings.groupGuide")}</div>
      </div>
      {routes.length > 0 && !groups.length && <p className="meta-txt dense fold-row-body" data-testid="im-only-direct">{t("imSettings.onlyDirect")}</p>}
      {open && (
        <div className="stack-2 fold-row-body">
          <ol className="meta-txt" style={{ margin: 0, paddingLeft: 18, whiteSpace: "pre-wrap", listStyle: "decimal" }}>
            {steps.map((step, i) => <li key={i}>{step}</li>)}
            <li>
              {t("imSettings.groupStepAfter")}
              <ul style={{ margin: 0, paddingLeft: 18, listStyle: "disc" }}>
                <li>{t("imSettings.afterWork")}</li>
                <li>{t("imSettings.afterStatus")}</li>
                <li>{t("imSettings.afterChat")}</li>
              </ul>
            </li>
          </ol>
          {groups.length > 0 && (
            <ul className="meta-txt dense" style={{ margin: 0, paddingLeft: 18, listStyle: "disc" }} data-testid="im-group-channels">
              {groups.map((r) => <li key={r.id}>{t("imSettings.groupChannel", { conversation: r.label ?? r.conversationId, role: t(roleOf(r)) })}</li>)}
            </ul>
          )}
        </div>
      )}
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
  const time = (at: number) => new Date(at).toLocaleTimeString(intlTag(locale), { hour: "2-digit", minute: "2-digit" });
  const routed = (row: ImIgnoredView) => im.routes.some((r) => r.connectionId === row.connectionId && r.tenantId === row.tenantId && r.conversationId === row.conversationId);
  const go = (row: ImIgnoredView, scope: "person" | "group") =>
    allow.mutate([{ ignoredId: row.id, scope, ...(routed(row) ? {} : { projectId }) }], { onError: (e) => onError(readableError(e)) });
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
            <div className="meta-txt dense">{row.group ? t("imSettings.group") : t("imSettings.dm")} · {row.conversationName ? <span title={row.conversationId}>{row.conversationName}</span> : <span className="mono">{row.conversationId}</span>} · {t(REASON_KEY[row.reason])}</div>
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
  const fail = { onError: (e: Error) => onError(readableError(e)) };
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
 * IM without JSON: what conversations hear, then bots and their credentials (each folds), pairing, the conversations
 * each project answers, and what was ignored or got stuck. Configuration lives
 * in the `im` settings section; live state comes from the IM service.
 */
export function ImPane({ scopeTag }: { scopeTag?: React.ReactNode }) {
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSaveSettings({ reportErrors: false });
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
    save.mutate({ ...settings.data, im: next }, { onSuccess: () => done?.(), onError: (e) => setError(readableError(e)) });
  };
  const installed = adapters.data ?? [];

  return (
    <>
      <SectionHead title={t("imSettings.label")} aside={scopeTag}>
        {t("imSettings.lede")}
      </SectionHead>
      <div className="stack-4">
        <SharedNotify notify={im.notify ?? SHARED} busy={save.isPending} onChange={(notify) => persist({ ...im, notify })} />
        <div className="stack-3" data-testid="im-bots">
          <SectionHead title={t("imSettings.connections")} aside={<Tag tone="neutral">{t("imSettings.connectedOfTotal", { connected, total: im.connections.length })}</Tag>} />
          <p className="meta-txt" data-testid="im-secret-storage" style={plaintext ? { color: "var(--warn)" } : undefined}>
            <Icon name={plaintext ? "i-warn" : "i-lock"} size={12} style={{ display: "inline", verticalAlign: "-1px" }} /> {plaintext ? t("imSettings.plaintext") : t("imSettings.keychain")}
          </p>
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
                onRemove={() => persist({ ...im, connections: im.connections.filter((c) => c.id !== view.id), identities: im.identities.filter((i) => i.connectionId !== view.id), routes: im.routes.filter((r) => r.connectionId !== view.id) })}
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
