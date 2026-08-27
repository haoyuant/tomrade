import type * as React from "react";
import type { Item, ItemStatus, Priority } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { PRIORITY_LABEL, STATUS, provenanceOf } from "~/lib/domain";
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

export const Kbd = ({ children }: { children: React.ReactNode }) => <span className="kbd">{children}</span>;

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
  if (priority === 2 && !always) return null;
  return (
    <Icon
      className={cn("prio", priority === 4 && "urgent")}
      name={`p-${priority}` as `p-${0 | 1 | 2 | 3 | 4}`}
      size={size}
      aria-label={`${PRIORITY_LABEL[priority]} priority`}
    />
  );
}

/**
 * Provenance is a margin mark: agent writes get a tick, human-locked fields a
 * glyph, human writes nothing. It sits in the gutter and never becomes a badge.
 */
export function ProvenanceMark({ item, height = 17 }: { item: Item; height?: number }) {
  const prov = provenanceOf(item);
  if (prov === "ai") return <span className="prov-tick" style={{ height }} title="Last written by an agent" />;
  if (prov === "locked") return <Icon className="prov-lock" name="i-lock" size={12} aria-label="Human-locked" />;
  return null;
}

export const LiveDot = () => <span className="live-dot" />;
