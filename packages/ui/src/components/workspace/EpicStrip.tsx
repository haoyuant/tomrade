import { useMemo, useState } from "react";
import type { FilterClause } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "./context";
import { ProgressRing } from "./EpicHeader";

/**
 * Which epics the board holds, without grouping it: one chip per epic with
 * open tickets. Hovering one fades the cards outside it; clicking one is the
 * same epic filter the query bar writes.
 */
export function EpicStrip() {
  const { t } = useI18n();
  const ws = useWorkspace();
  const [hover, setHover] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const progress = ws.epicProgress;

  const at = ws.query.filter.findIndex((c) => c.field === "epic" && c.op === "in");
  const chosen = new Set((at >= 0 ? ws.query.filter[at].values : []).filter((v): v is string => typeof v === "string"));

  const epics = ws.epics;
  const { open, finished } = useMemo(() => {
    const open: typeof epics = [];
    const finished: typeof epics = [];
    for (const epic of epics) {
      const p = progress.get(epic.id);
      if (!p || p.total === 0) continue;
      (p.done < p.total ? open : finished).push(epic);
    }
    return { open, finished };
  }, [epics, progress]);

  if (open.length + finished.length === 0) return null;

  const toggle = (id: string) => {
    const next = new Set(chosen);
    if (!next.delete(id)) next.add(id);
    const filter = [...ws.query.filter];
    const clause: FilterClause = { field: "epic", op: "in", values: [...next] };
    if (at >= 0) {
      if (next.size) filter[at] = clause;
      else filter.splice(at, 1);
    } else filter.push(clause);
    ws.setQuery({ ...ws.query, filter });
  };

  const shown = [...open, ...(showFinished ? finished : finished.filter((e) => chosen.has(e.id)))];
  const hidden = finished.length - (showFinished ? finished.length : finished.filter((e) => chosen.has(e.id)).length);

  return (
    <div className="epic-strip" role="toolbar" aria-label={t("epics.stripAria")}>
      {/* Faded by attribute, so hovering re-renders this strip and not the board. */}
      {hover && <style>{`.board-region .card:not([data-epic="${CSS.escape(hover)}"]) { opacity: 0.32; }`}</style>}
      <span className="epic-strip-label">
        <Icon name="i-stack" size={12} />
        {t("epics.stripLabel")}
      </span>
      {shown.map((epic) => {
        const p = progress.get(epic.id)!;
        const on = chosen.has(epic.id);
        return (
          <button
            type="button"
            key={epic.id}
            className="epic-chip"
            data-on={on}
            aria-pressed={on}
            title={`${epic.key} · ${epic.title}\n${t("epics.progress", { done: String(p.done), total: String(p.total) })}\n${t(on ? "epics.filterOff" : "epics.filterOn", { name: epic.title })}`}
            onClick={() => toggle(epic.id)}
            onMouseEnter={() => setHover(epic.id)}
            onMouseLeave={() => setHover(null)}
            onFocus={() => setHover(epic.id)}
            onBlur={() => setHover(null)}
          >
            <ProgressRing done={p.done} total={p.total} />
            <span className="epic-chip-name">{epic.title}</span>
            <span className="epic-chip-n num">{t("epics.progressShort", { done: String(p.done), total: String(p.total) })}</span>
          </button>
        );
      })}
      {(hidden > 0 || showFinished) && finished.length > 0 && (
        <button type="button" className="epic-chip epic-chip-more" onClick={() => setShowFinished((v) => !v)}>
          {showFinished ? t("epics.fewer") : t("epics.more", { n: String(hidden) })}
        </button>
      )}
    </div>
  );
}
