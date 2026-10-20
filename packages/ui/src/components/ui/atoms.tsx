import type * as React from "react";
import type { Item, ItemStatus, Priority } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { PRIORITY_LABEL, STATUS, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

/** Numbers that stack get tabular-nums. Not prose. */
export const Num = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span className={cn("num", className)}>{children}</span>
);

export const Eyebrow = ({ children, className, ...rest }: React.HTMLAttributes<HTMLParagraphElement>) => (
  <p className={cn("eyebrow", className)} {...rest}>
    {children}
  </p>
);

/** Every settings pane opens with one of these; the menu row beside it repeats the title. */
export const SectionHead = ({ title, aside, children }: { title: string; aside?: React.ReactNode; children?: React.ReactNode }) => (
  <div className="sec-head">
    <div>
      <h3 className="sec-title">{title}</h3>
      {children && (
        <p className="sec-lede" style={{ marginTop: 4 }}>
          {children}
        </p>
      )}
    </div>
    {aside && <div style={{ marginLeft: "auto" }}>{aside}</div>}
  </div>
);

/** A quiet disclosure: what most people never need stays behind its one line until asked for. */
export const Fold = ({ id, title, open, onToggle, children }: { id: string; title: React.ReactNode; open: boolean; onToggle: () => void; children: React.ReactNode }) => (
  <section className={cn("fold", !open && "folded")} data-fold={id}>
    <button type="button" className="fold-head" aria-expanded={open} onClick={onToggle}>
      <Icon name={open ? "i-chevdown" : "i-chev"} size={12} />
      <span className="fold-title">{title}</span>
    </button>
    {open && <div className="fold-body">{children}</div>}
  </section>
);

/**
 * A row that folds opens from this chevron, left of the row and outside its card.
 * With a `label` it is the row's own toggle; without one the row is itself the
 * button, and the chevron only shows which way it is.
 */
export const FoldChevron = ({ open, label, disabled, onToggle, testId }: { open: boolean; label?: string; disabled?: boolean; onToggle: () => void; testId?: string }) => (
  <button type="button" className="btn btn-icon fold-chev" aria-expanded={label ? open : undefined} aria-label={label} title={label} aria-hidden={label ? undefined : true} tabIndex={label ? undefined : -1}
    disabled={disabled} onClick={(e) => { e.stopPropagation(); onToggle(); }} data-testid={testId}>
    <Icon name="i-chevdown" size={14} style={open ? undefined : { transform: "rotate(-90deg)" }} />
  </button>
);

/** Holds a chevron's place in a row that doesn't fold, so it lines up with those that do. */
export const FoldChevronSpace = () => <span className="fold-chev-space" aria-hidden />;

/** An empty label is a command the person unbound: no key cap at all. */
export const Kbd = ({ children }: { children: React.ReactNode }) => (children === "" ? null : <span className="kbd">{children}</span>);

export const Spacer = () => <div className="spacer" />;

export const Tag = ({ tone, title, children }: { tone?: "faint" | "neutral" | "strong"; title?: string; children: React.ReactNode }) => (
  <span className={cn("tag", tone)} title={title}>
    {children}
  </span>
);

export const StatusMark = ({ status, size = 12 }: { status: ItemStatus; size?: number }) => (
  <Icon className={cn("sdot", status === "done" && "done")} name={STATUS[status].mark} size={size} aria-hidden />
);

/** Suppressed at Medium — the default value, so a glyph always means something. */
export function PriorityGlyph({ priority, size = 12, always = false }: { priority: Priority; size?: number; always?: boolean }) {
  const { t } = useI18n();
  if (priority === 2 && !always) return null;
  return (
    <Icon
      className={cn("prio", priority === 4 && "urgent")}
      name={`p-${priority}` as `p-${0 | 1 | 2 | 3 | 4}`}
      size={size}
      aria-label={t("common.priorityAria", { priority: PRIORITY_LABEL[priority] })}
    />
  );
}

/**
 * Provenance is a margin mark: agent writes get a tick, human-locked fields a
 * glyph, human writes nothing. It sits in the gutter and never becomes a badge.
 */
export function ProvenanceMark({ item, height = 17 }: { item: Item; height?: number }) {
  const { t } = useI18n();
  const prov = provenanceOf(item);
  if (prov === "ai") return <span className="prov-tick" style={{ height }} title={t("common.agentWrite")} />;
  if (prov === "sync") return <span className="prov-tick is-sync" style={{ height }} title={t("common.syncWrite")} />;
  if (prov === "locked") return <Icon className="prov-lock" name="i-lock" size={12} aria-label={t("common.humanLocked")} />;
  return null;
}

export const LiveDot = () => <span className="live-dot" />;
