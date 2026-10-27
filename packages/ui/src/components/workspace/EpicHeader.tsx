import type { Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { PriorityGlyph, StatusMark } from "~/components/ui/atoms";
import { PRIORITY_LABEL, STATUS } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";

export interface EpicProgress {
  done: number;
  total: number;
}

/** A ring that fills as the epic's tickets finish — shape, not hue, like the status marks. */
export function ProgressRing({ done, total, size = 12 }: EpicProgress & { size?: number }) {
  const r = size / 2 - 1.5;
  const c = 2 * Math.PI * r;
  const full = total > 0 && done >= total;
  return (
    <svg className={full ? "epic-ring done" : "epic-ring"} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.3} strokeWidth={1.5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeDasharray={`${total ? (c * done) / total : 0} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function EpicProgressBar({ done, total }: EpicProgress) {
  const { t } = useI18n();
  const full = total > 0 && done >= total;
  return (
    <span className="epic-progress" title={t("epics.progress", { done: String(done), total: String(total) })}>
      <span className="epic-bar" aria-hidden>
        <span className={full ? "epic-bar-fill done" : "epic-bar-fill"} style={{ width: `${total ? (100 * done) / total : 0}%` }} />
      </span>
      <span className="epic-progress-n num">{t("epics.progressShort", { done: String(done), total: String(total) })}</span>
    </span>
  );
}

/**
 * The head of an epic's group, shared by table groups and board swimlanes:
 * the chevron folds it, the title opens the epic. Without an epic it is the
 * "No epic" bucket, muted.
 */
export function EpicTitle({
  epic,
  label,
  count,
  collapsed,
  onToggle,
  onOpen
}: {
  epic: Item | undefined;
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <span className={epic ? "epic-title" : "epic-title is-none"}>
      <button type="button" className="epic-chev-btn" aria-expanded={!collapsed} title={t(collapsed ? "epics.expand" : "epics.collapse")} onClick={onToggle}>
        <Icon className="lane-chev" name="i-chev" size={12} style={{ transform: collapsed ? "rotate(0deg)" : undefined }} />
      </button>
      {epic ? (
        <button type="button" className="epic-open" title={t("epics.openTitle")} onClick={() => onOpen(epic.id)}>
          <Icon className="epic-glyph" name="i-stack" size={13} />
          <span className="card-id">{epic.key}</span>
          <span className="epic-name">{epic.title}</span>
        </button>
      ) : (
        <button type="button" className="epic-open" onClick={onToggle}>
          <span className="epic-name">{label}</span>
          <span className="lane-count num">{count}</span>
        </button>
      )}
    </span>
  );
}

/** The epic's own status and priority, as words beside their glyphs. */
export function EpicStatus({ epic }: { epic: Item }) {
  return (
    <span className="epic-status">
      <StatusMark status={epic.status} />
      <span>{STATUS[epic.status].label}</span>
    </span>
  );
}

export function EpicPriority({ epic }: { epic: Item }) {
  return (
    <span className="epic-status">
      <PriorityGlyph priority={epic.priority} always />
      <span>{PRIORITY_LABEL[epic.priority]}</span>
    </span>
  );
}
