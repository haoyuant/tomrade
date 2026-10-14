import { useEffect, useRef, useState } from "react";
import type { Cadence, Schedule, Suggestion, Template, TemplateInput, TicketSpec } from "@tomradex/schedules";
import { Icon } from "~/components/icons";
import { Eyebrow, SectionHead, Spacer, Tag } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { findEngine, useEngines } from "~/lib/agent";
import { agoLabel, PRIORITIES, PRIORITY_LABEL } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { cadenceLabel, dayNames, nextLabel, useSchedules, useSuggestions, useTemplateActions, useTemplateRuns, useTemplates } from "~/lib/templates";
import { errorSpec, useToast } from "~/lib/toast";

type Draft = { name: string; description: string; action: TemplateInput["action"] };
type TicketDraft = Partial<TicketSpec> & { title: string };

const blankTicket = (): TicketDraft => ({ title: "", body: "", workType: "general", status: "todo", priority: 2, labels: [], start: false });
const BLANK: Draft = { name: "", description: "", action: { kind: "tickets", items: [blankTicket()] } };
const draftOf = (t: Template): Draft => ({ name: t.name, description: t.description, action: t.action });

const valid = (d: Draft) => !!d.name.trim() && (d.action.kind === "tickets" ? d.action.items.length > 0 && d.action.items.every((i) => i.title.trim()) : !!d.action.prompt.trim());

/**
 * One routine, opened from its card on the Routines screen: what it does, its
 * schedules and its recent runs. `templateId` "new" makes one; null is shut.
 */
export function RoutineDialog({
  projectId,
  templateId,
  onOpenChange,
  onCreated,
  onOpenIssue,
  onOpenThread
}: {
  projectId: string;
  templateId: string | null;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
  onOpenIssue: (id: string) => void;
  onOpenThread: (id: string) => void;
}) {
  const { t } = useI18n();
  const templates = useTemplates(projectId);
  const schedules = useSchedules(projectId);
  const current = (templates.data ?? []).find((x) => x.id === templateId) ?? null;
  // Deleted elsewhere: the dialog goes with it. One just made waits for the list to catch up.
  const seen = useRef(false);
  useEffect(() => {
    if (current) seen.current = true;
    else if (seen.current && templateId !== "new") {
      seen.current = false;
      onOpenChange(false);
    }
  }, [current, templateId, onOpenChange]);
  const open = templateId !== null && (templateId === "new" || !!current);
  const title = current?.name ?? t("templates.new");

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={title} className="sheet-templates" resizable="templates">
      <DialogHead title={title} />
      <DialogBody className="template-body">
        {open && (
          <TemplateEditor
            key={templateId}
            projectId={projectId}
            template={current}
            schedules={(schedules.data ?? []).filter((s) => s.templateId === current?.id)}
            onSaved={(id) => templateId === "new" && onCreated(id)}
            onDeleted={() => onOpenChange(false)}
            onOpenIssue={onOpenIssue}
            onOpenThread={onOpenThread}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}

const GROUPS = ["everyday", "work", "coding"] as const;
const GROUP_WORD: Record<(typeof GROUPS)[number], MessageKey> = { everyday: "templates.groupEveryday", work: "templates.groupWork", coding: "templates.groupCoding" };

export function SuggestionsPane({ projectId, templates, onOpen }: { projectId: string; templates: Template[]; onOpen: (id: string) => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const gallery = useSuggestions(locale);
  const { addSuggestion } = useTemplateActions(projectId);
  const addedFrom = new Map(templates.filter((x) => x.suggestion).map((x) => [x.suggestion!, x.id]));
  const add = (s: Suggestion) =>
    addSuggestion.mutate({ id: s.id, withSchedule: !!s.cadence }, { onSuccess: ({ template }) => onOpen(template.id), onError: (err) => toast(errorSpec(err)) });
  return (
    <>
      <SectionHead title={t("templates.suggestions")} />
      {GROUPS.map((group) => {
        const items = (gallery.data ?? []).filter((s) => s.group === group);
        if (!items.length) return null;
        return (
          <div key={group} className="stack-3" style={{ marginBottom: "var(--space-5)" }}>
            <Eyebrow>{t(GROUP_WORD[group])}</Eyebrow>
            <div className="template-gallery">
              {items.map((s) => {
                const own = addedFrom.get(s.id);
                return (
                  <div key={s.id} className="panel template-card" data-suggestion={s.id}>
                    <div className="row" style={{ gap: "var(--space-2)", alignItems: "baseline" }}>
                      <span className="cfg-name">{s.template.name}</span>
                      <Tag tone="faint">{s.template.action.kind === "assistant" ? t("templates.kindAssistant") : t("templates.kindTickets")}</Tag>
                    </div>
                    <p className="meta-txt dense">{s.template.description}</p>
                    <div className="row" style={{ gap: "var(--space-2)", alignItems: "center" }}>
                      <span className="meta-txt">{s.cadence ? cadenceLabel(s.cadence, locale) : t("templates.byHand")}</span>
                      <Spacer />
                      {own ? (
                        <button type="button" className="btn btn-ghost" onClick={() => onOpen(own)}>
                          {t("templates.added")} →
                        </button>
                      ) : (
                        <button type="button" className="btn btn-secondary" data-testid={`suggestion-add-${s.id}`} disabled={addSuggestion.isPending} onClick={() => add(s)}>
                          {t("templates.add")}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}

function TemplateEditor({
  projectId,
  template,
  schedules,
  onSaved,
  onDeleted,
  onOpenIssue,
  onOpenThread
}: {
  projectId: string;
  template: Template | null;
  schedules: Schedule[];
  onSaved: (id: string) => void;
  onDeleted: () => void;
  onOpenIssue: (id: string) => void;
  onOpenThread: (id: string) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const engines = useEngines();
  const actions = useTemplateActions(projectId);
  const [draft, setDraft] = useState<Draft>(template ? draftOf(template) : BLANK);
  const [removing, setRemoving] = useState(false);
  const dirty = !template || JSON.stringify(draftOf(template)) !== JSON.stringify(draft);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const items = draft.action.kind === "tickets" ? draft.action.items : [];
  const setItems = (next: TicketDraft[]) => set({ action: { kind: "tickets", items: next as TicketSpec[] } });
  const setItem = (i: number, patch: Partial<TicketDraft>) => setItems(items.map((it, n) => (n === i ? { ...it, ...patch } : it)));

  const save = () => {
    const input = { name: draft.name, description: draft.description, action: draft.action } as TemplateInput;
    const done = (saved: Template) => {
      toast({ body: t("templates.saved", { name: saved.name }) });
      onSaved(saved.id);
    };
    if (template) actions.update.mutate({ id: template.id, input }, { onSuccess: done, onError: (err) => toast(errorSpec(err)) });
    else actions.create.mutate(input, { onSuccess: done, onError: (err) => toast(errorSpec(err)) });
  };
  const run = () =>
    template &&
    actions.run.mutate(template.id, {
      onSuccess: (r) =>
        toast(
          r.ok
            ? { body: r.itemIds.length ? t(r.itemIds.length === 1 ? "templates.ranTicket" : "templates.ranTickets", { name: template.name, n: r.itemIds.length }) : t("templates.ran", { name: template.name }) }
            : { body: t("templates.failed", { name: template.name, error: r.error ?? "" }) }
        ),
      onError: (err) => toast(errorSpec(err))
    });

  return (
    <div className={template ? "template-editor" : "template-editor solo"} data-testid="template-editor">
      <div className="template-main">
        <div className="field">
          <label htmlFor="tplName">{t("templates.name")}</label>
          <input id="tplName" className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="tplDesc">{t("templates.description")}</label>
          <input id="tplDesc" className="input" value={draft.description} onChange={(e) => set({ description: e.target.value })} />
        </div>
        <div className="field">
          <label>{t("templates.what")}</label>
          <div className="seg" role="group">
            <button type="button" aria-pressed={draft.action.kind === "tickets"} onClick={() => draft.action.kind !== "tickets" && set({ action: { kind: "tickets", items: [blankTicket() as TicketSpec] } })}>
              {t("templates.kindTickets")}
            </button>
            <button type="button" aria-pressed={draft.action.kind === "assistant"} onClick={() => draft.action.kind !== "assistant" && set({ action: { kind: "assistant", prompt: "", engine: null, options: null } })}>
              {t("templates.kindAssistant")}
            </button>
          </div>
          <span className="meta-txt">{t("templates.placeholders")}</span>
        </div>

        {draft.action.kind === "tickets" ? (
          <>
            <div className="template-tickets">
              {items.map((it, i) => (
                <div key={i} className="panel stack-3 template-ticket" data-ticket={i}>
                  <div className="row" style={{ gap: "var(--space-2)", alignItems: "end" }}>
                    <div className="field" style={{ flex: 1 }}>
                      <label htmlFor={`tplT${i}`}>{t("templates.ticketTitle")}</label>
                      <input id={`tplT${i}`} className="input" value={it.title} onChange={(e) => setItem(i, { title: e.target.value })} />
                    </div>
                    {items.length > 1 && (
                      <button type="button" className="btn btn-ghost" onClick={() => setItems(items.filter((_, n) => n !== i))}>
                        {t("templates.removeTicket")}
                      </button>
                    )}
                  </div>
                  <div className="field">
                    <label htmlFor={`tplB${i}`}>{t("templates.ticketBody")}</label>
                    <textarea id={`tplB${i}`} className="textarea" rows={3} value={it.body ?? ""} onChange={(e) => setItem(i, { body: e.target.value })} />
                    <span className="meta-txt">{t("templates.bodyHint")}</span>
                  </div>
                  <div className="template-grid">
                    <div className="field">
                      <label htmlFor={`tplS${i}`}>{t("templates.status")}</label>
                      <select id={`tplS${i}`} className="select" value={it.status ?? "todo"} onChange={(e) => setItem(i, { status: e.target.value as "todo" | "backlog" })}>
                        <option value="todo">{t("templates.todo")}</option>
                        <option value="backlog">{t("templates.backlog")}</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`tplP${i}`}>{t("templates.priority")}</label>
                      <select id={`tplP${i}`} className="select" value={it.priority ?? 2} onChange={(e) => setItem(i, { priority: Number(e.target.value) })}>
                        {PRIORITIES.map((p) => (
                          <option key={p} value={p}>
                            {PRIORITY_LABEL[p]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`tplW${i}`}>{t("templates.workType")}</label>
                      <select id={`tplW${i}`} className="select" value={it.workType ?? "general"} onChange={(e) => setItem(i, { workType: e.target.value as "general" | "coding" })}>
                        <option value="general">{t("templates.general")}</option>
                        <option value="coding">{t("templates.coding")}</option>
                      </select>
                    </div>
                    <div className="field">
                      <label htmlFor={`tplL${i}`}>{t("templates.labels")}</label>
                      <LabelsInput id={`tplL${i}`} placeholder={t("templates.labelsHint")} value={it.labels ?? []} onChange={(labels) => setItem(i, { labels })} />
                    </div>
                  </div>
                  <div className="cfg-row">
                    <span className="cfg-name">{t("templates.start")}</span>
                    <button type="button" className="switch" role="switch" aria-checked={!!it.start} aria-label={t("templates.start")} onClick={() => setItem(i, { start: !it.start })} />
                  </div>
                </div>
              ))}
            </div>
            {items.length < 20 && (
              <div>
                <button type="button" className="btn btn-ghost" data-testid="template-add-ticket" onClick={() => setItems([...items, blankTicket()])}>
                  {t("templates.addTicket")}
                </button>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="tplPrompt">{t("templates.prompt")}</label>
              <textarea id="tplPrompt" className="textarea" rows={5} value={draft.action.prompt} onChange={(e) => set({ action: { ...(draft.action as Extract<Draft["action"], { kind: "assistant" }>), prompt: e.target.value } })} />
            </div>
            <div className="field">
              <label htmlFor="tplEngine">{t("templates.engine")}</label>
              <select
                id="tplEngine"
                className="select"
                value={findEngine(engines.data, draft.action.engine)?.id ?? draft.action.engine ?? ""}
                onChange={(e) => set({ action: { ...(draft.action as Extract<Draft["action"], { kind: "assistant" }>), engine: e.target.value || null } })}
              >
                <option value="">{t("templates.defaultEngine")}</option>
                {(engines.data ?? [])
                  .filter((e) => !e.terminalOnly && e.capabilities.includes("backlog"))
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title}
                    </option>
                  ))}
              </select>
            </div>
          </>
        )}

        <div className="row" style={{ gap: "var(--space-2)" }}>
          <button type="button" className="btn btn-primary" data-testid="template-save" disabled={!dirty || !valid(draft) || actions.create.isPending || actions.update.isPending} onClick={save}>
            {t("templates.save")}
          </button>
          {template && (
            <button type="button" className="btn btn-secondary" data-testid="template-run" disabled={actions.run.isPending} onClick={run}>
              {t("templates.runNow")}
            </button>
          )}
          <Spacer />
          {template && (
            <button
              type="button"
              className={removing ? "btn btn-danger" : "btn btn-ghost"}
              onClick={() => (removing ? actions.remove.mutate(template.id, { onSuccess: onDeleted, onError: (err) => toast(errorSpec(err)) }) : setRemoving(true))}
            >
              {removing ? t("templates.removeSure") : t("templates.remove")}
            </button>
          )}
        </div>
      </div>
      {template && (
        <div className="template-side">
          <SchedulesBlock projectId={projectId} templateId={template.id} schedules={schedules} />
          <RunsBlock projectId={projectId} templateId={template.id} onOpenIssue={onOpenIssue} onOpenThread={onOpenThread} />
        </div>
      )}
    </div>
  );
}

const splitLabels = (text: string) => text.split(/[,，]/).map((l) => l.trim()).filter(Boolean);

/** What is typed stays as typed — a trailing comma included — and is read as labels as it changes. */
function LabelsInput({ id, placeholder, value, onChange }: { id: string; placeholder: string; value: string[]; onChange: (labels: string[]) => void }) {
  const [text, setText] = useState(value.join(", "));
  return (
    <input
      id={id}
      className="input"
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(splitLabels(e.target.value));
      }}
      onBlur={() => setText(splitLabels(text).join(", "))}
    />
  );
}

function CadenceEditor({ value, onChange }: { value: Cadence; onChange: (next: Cadence) => void }) {
  const { t, locale } = useI18n();
  const at = "at" in value ? value.at : "09:00";
  const pick = (kind: Cadence["kind"]) => {
    switch (kind) {
      case "daily":
      case "weekdays":
        return onChange({ kind, at });
      case "weekly":
        return onChange({ kind, at, days: [1] });
      case "days":
        return onChange({ kind, at, every: 3 });
      case "monthly":
        return onChange({ kind, at, day: 1 });
      case "hourly":
        return onChange({ kind, every: 6 });
    }
  };
  return (
    <div className="stack-3">
      <div className="template-grid">
        <div className="field">
          <label htmlFor="cdKind">{t("templates.schedules")}</label>
          <select id="cdKind" className="select" value={value.kind} onChange={(e) => pick(e.target.value as Cadence["kind"])}>
            <option value="daily">{t("templates.kindDaily")}</option>
            <option value="weekdays">{t("templates.kindWeekdays")}</option>
            <option value="weekly">{t("templates.kindWeekly")}</option>
            <option value="days">{t("templates.kindDays")}</option>
            <option value="monthly">{t("templates.kindMonthly")}</option>
            <option value="hourly">{t("templates.kindHourly")}</option>
          </select>
        </div>
        {value.kind !== "hourly" && (
          <div className="field">
            <label htmlFor="cdAt">{t("templates.at")}</label>
            <input id="cdAt" className="input num" type="time" value={value.at} onChange={(e) => onChange({ ...value, at: e.target.value || "09:00" })} />
          </div>
        )}
        {(value.kind === "days" || value.kind === "hourly") && (
          <div className="field">
            <label htmlFor="cdEvery">
              {t("templates.every")} ({value.kind === "days" ? t("templates.daysUnit") : t("templates.hoursUnit")})
            </label>
            <input
              id="cdEvery"
              className="input num"
              type="number"
              min={value.kind === "days" ? 2 : 1}
              max={value.kind === "days" ? 90 : 24}
              value={value.every}
              onChange={(e) => onChange({ ...value, every: Math.min(value.kind === "days" ? 90 : 24, Math.max(value.kind === "days" ? 2 : 1, Number(e.target.value) || 1)) } as Cadence)}
            />
          </div>
        )}
        {value.kind === "monthly" && (
          <div className="field">
            <label htmlFor="cdDay">{t("templates.dayOfMonth")}</label>
            <input id="cdDay" className="input num" type="number" min={1} max={28} value={value.day} onChange={(e) => onChange({ ...value, day: Math.min(28, Math.max(1, Number(e.target.value) || 1)) })} />
          </div>
        )}
      </div>
      {value.kind === "weekly" && (
        <div className="seg template-days" role="group" aria-label={t("templates.kindWeekly")}>
          {dayNames(locale).map((name, i) => {
            const on = value.days.includes(i + 1);
            const next = on ? value.days.filter((d) => d !== i + 1) : [...value.days, i + 1];
            return (
              <button key={name} type="button" aria-pressed={on} onClick={() => next.length && onChange({ ...value, days: next })}>
                {name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SchedulesBlock({ projectId, templateId, schedules }: { projectId: string; templateId: string; schedules: Schedule[] }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { schedule, reschedule, unschedule } = useTemplateActions(projectId);
  const [adding, setAdding] = useState<{ cadence: Cadence; catchUp: boolean } | null>(null);
  return (
    <div className="panel stack-3" data-testid="template-schedules">
      <div>
        <Eyebrow>{t("templates.schedules")}</Eyebrow>
        <p className="meta-txt dense">{t("templates.schedulesLede")}</p>
      </div>
      {!schedules.length && !adding && <p className="meta-txt">{t("templates.noSchedules")}</p>}
      {schedules.map((s) => (
        <div key={s.id} className="cfg-row" data-schedule={s.id}>
          <Icon name="i-alarm" size={14} />
          <span className="cfg-name">{cadenceLabel(s.cadence, locale)}</span>
          <span className="meta-txt">{s.enabled && s.nextRunAt ? t("templates.next", { when: nextLabel(s.nextRunAt, locale) }) : t("templates.paused")}</span>
          <Spacer />
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={s.enabled}
            aria-label={cadenceLabel(s.cadence, locale)}
            onClick={() => reschedule.mutate({ id: s.id, input: { templateId, cadence: s.cadence, catchUp: s.catchUp, enabled: !s.enabled } }, { onError: (err) => toast(errorSpec(err)) })}
          />
          <button type="button" className="btn btn-icon" aria-label={t("templates.deleteSchedule")} title={t("templates.deleteSchedule")} onClick={() => unschedule.mutate(s.id)}>
            <Icon name="i-close" size={12} />
          </button>
        </div>
      ))}
      {adding ? (
        <div className="stack-3">
          <CadenceEditor value={adding.cadence} onChange={(cadence) => setAdding({ ...adding, cadence })} />
          <div className="cfg-row">
            <span className="cfg-name">{t("templates.catchUp")}</span>
            <button type="button" className="switch" role="switch" aria-checked={adding.catchUp} aria-label={t("templates.catchUp")} onClick={() => setAdding({ ...adding, catchUp: !adding.catchUp })} />
          </div>
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <button
              type="button"
              className="btn btn-primary"
              data-testid="schedule-save"
              disabled={schedule.isPending}
              onClick={() => schedule.mutate({ templateId, cadence: adding.cadence, catchUp: adding.catchUp }, { onSuccess: () => setAdding(null), onError: (err) => toast(errorSpec(err)) })}
            >
              {t("templates.save")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(null)}>
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button type="button" className="btn btn-ghost" data-testid="schedule-add" onClick={() => setAdding({ cadence: { kind: "daily", at: "09:00" }, catchUp: true })}>
            {t("templates.addSchedule")}
          </button>
        </div>
      )}
    </div>
  );
}

function RunsBlock({ projectId, templateId, onOpenIssue, onOpenThread }: { projectId: string; templateId: string; onOpenIssue: (id: string) => void; onOpenThread: (id: string) => void }) {
  const { t } = useI18n();
  const runs = useTemplateRuns(projectId, templateId);
  const list = runs.data ?? [];
  return (
    <div className="stack-3" data-testid="template-runs">
      <Eyebrow>{t("templates.runs")}</Eyebrow>
      {!list.length && <p className="meta-txt">{t("templates.never")}</p>}
      {list.map((r) => (
        <p key={r.id} className={r.ok ? "meta-txt dense" : "meta-txt dense template-failed"}>
          {agoLabel(r.at)} · {t(`templates.trigger_${r.trigger}` as MessageKey)}
          {!r.ok && ` · ${r.error ?? ""}`}
          {r.itemIds.length > 0 && (
            <>
              {" · "}
              <button type="button" className="link-btn" onClick={() => onOpenIssue(r.itemIds[0]!)}>
                {t("templates.openTicket")}
              </button>
            </>
          )}
          {r.threadId && (
            <>
              {" · "}
              <button type="button" className="link-btn" onClick={() => onOpenThread(r.threadId!)}>
                {t("templates.openThread")}
              </button>
            </>
          )}
        </p>
      ))}
    </div>
  );
}
