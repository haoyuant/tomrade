import { useState } from "react";
import type { Schedule, Template } from "@tomradex/schedules";
import { Icon } from "~/components/icons";
import { SectionHead, Spacer, Tag } from "~/components/ui/atoms";
import { RoutineDialog, SuggestionsPane } from "~/components/dialogs/TemplatesDialog";
import { agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { cadenceLabel, nextLabel, useSchedules, useTemplateActions, useTemplateRuns, useTemplates } from "~/lib/templates";
import { errorSpec, useToast } from "~/lib/toast";

/**
 * The project's routines as a screen of its own, like Files: the person's
 * routines as cards, each with its schedule switch, and the suggestions below.
 * A card opens the routine in a dialog.
 */
export function RoutinesRegion({ projectId, onOpenIssue, onOpenThread }: { projectId: string; onOpenIssue: (id: string) => void; onOpenThread: (id: string) => void }) {
  const { t } = useI18n();
  const templates = useTemplates(projectId);
  const schedules = useSchedules(projectId);
  /** The routine open in the dialog: an id, "new", or null. */
  const [opened, setOpened] = useState<string | null>(null);
  const all = templates.data ?? [];

  return (
    <section className="board-region routines-region" data-testid="routines-region">
      <div className="board-head routines-head">
        <Icon className="view-ico" name="i-alarm" size={16} />
        <h1 className="board-title">{t("templates.title")}</h1>
        <Spacer />
        {!templates.isError && (
          <button type="button" className="btn btn-secondary" data-testid="template-new" onClick={() => setOpened("new")}>
            <Icon name="i-plus" size={13} /> {t("templates.new")}
          </button>
        )}
      </div>
      <div className="routines-main">
        {templates.isError ? (
          <p className="meta-txt">{t("templates.off")}</p>
        ) : (
          <>
            <SectionHead title={t("templates.yours")}>{t("templates.lede")}</SectionHead>
            {templates.isSuccess && !all.length ? (
              <p className="meta-txt routines-none">{t("templates.none")}</p>
            ) : (
              <div className="routine-grid" data-testid="routine-cards">
                {all.map((x) => (
                  <RoutineCard key={x.id} projectId={projectId} template={x} schedules={(schedules.data ?? []).filter((s) => s.templateId === x.id)} onOpen={() => setOpened(x.id)} />
                ))}
              </div>
            )}
            <div className="routines-suggestions" data-testid="templates-suggestions">
              <SuggestionsPane projectId={projectId} templates={all} onOpen={setOpened} />
            </div>
          </>
        )}
      </div>
      <RoutineDialog
        projectId={projectId}
        templateId={opened}
        onOpenChange={(open) => !open && setOpened(null)}
        onCreated={setOpened}
        onOpenIssue={(id) => {
          setOpened(null);
          onOpenIssue(id);
        }}
        onOpenThread={(id) => {
          setOpened(null);
          onOpenThread(id);
        }}
      />
    </section>
  );
}

/** One routine at a glance; the switch turns all its schedules on or off together, and the bin asks once before deleting. */
function RoutineCard({ projectId, template, schedules, onOpen }: { projectId: string; template: Template; schedules: Schedule[]; onOpen: () => void }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const { reschedule, remove } = useTemplateActions(projectId);
  const [confirming, setConfirming] = useState(false);
  const runs = useTemplateRuns(projectId, template.id);
  const last = runs.data?.[0];
  const on = schedules.some((s) => s.enabled);
  const next = schedules
    .filter((s) => s.enabled && s.nextRunAt)
    .map((s) => s.nextRunAt!)
    .sort((a, b) => a - b)[0];
  const action = template.action;

  const toggle = () => {
    for (const s of schedules) {
      if (s.enabled === !on) continue;
      reschedule.mutate({ id: s.id, input: { templateId: template.id, cadence: s.cadence, catchUp: s.catchUp, enabled: !on } }, { onError: (err) => toast(errorSpec(err)) });
    }
  };

  return (
    <div className={on ? "panel routine-card is-on" : "panel routine-card"} data-template={template.id}>
      <div className="row routine-card-top">
        <button type="button" className="routine-card-open cfg-name" aria-label={t("templates.open", { name: template.name })} onClick={onOpen}>
          {template.name}
        </button>
        <Tag tone="faint">{action.kind === "assistant" ? t("templates.kindAssistant") : t("templates.kindTickets")}</Tag>
        <Spacer />
        {schedules.length > 0 && (
          <button
            type="button"
            className="switch"
            role="switch"
            aria-checked={on}
            aria-label={`${t("templates.onSchedule")} · ${template.name}`}
            title={t("templates.onSchedule")}
            disabled={reschedule.isPending}
            onClick={toggle}
          />
        )}
        <button
          type="button"
          className="btn btn-icon is-danger routine-card-del"
          aria-label={`${t("templates.remove")} · ${template.name}`}
          title={t("templates.remove")}
          aria-pressed={confirming}
          onClick={() => setConfirming((v) => !v)}
        >
          <Icon name="i-trash" size={14} />
        </button>
      </div>
      {template.description && <p className="meta-txt dense routine-card-desc">{template.description}</p>}
      <div className="routine-card-when">
        <Icon name={schedules.length ? "i-alarm" : "i-stack"} size={13} />
        <span>
          {schedules.length ? cadenceLabel(schedules[0]!.cadence, locale) : t("templates.byHand")}
          {schedules.length > 1 && ` · ${t("templates.moreSchedules", { n: schedules.length - 1 })}`}
        </span>
        {schedules.length > 0 && <span className="meta-txt">· {on && next ? t("templates.next", { when: nextLabel(next, locale) }) : t("templates.paused")}</span>}
      </div>
      {confirming ? (
        <div className="row routine-card-confirm" role="group" aria-label={t("templates.removeSure")}>
          <span className="meta-txt">{t("templates.removeSure")}</span>
          <Spacer />
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
            {t("common.cancel")}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            data-testid="routine-delete"
            disabled={remove.isPending}
            onClick={() => remove.mutate(template.id, { onError: (err) => toast(errorSpec(err)) })}
          >
            {t("common.delete")}
          </button>
        </div>
      ) : (
        <p className={last && !last.ok ? "meta-txt dense template-failed" : "meta-txt dense"}>
          {last ? t(last.ok ? "templates.lastRun" : "templates.lastFailed", { when: agoLabel(last.at) }) : t("templates.never")}
        </p>
      )}
    </div>
  );
}
