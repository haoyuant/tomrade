import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Board, FieldDef, FieldValue, Item, ItemStatus, Patch, Priority } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { PriorityGlyph, StatusMark } from "~/components/ui/atoms";
import { PRIORITIES, PRIORITY_LABEL, STATUS, STATUS_KEYS, isTicket } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { usePatchItem } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import { useToastUndo } from "~/lib/undo";

/**
 * One write path for every editable field on an issue, shared by the docked
 * detail pane, the expanded overlay and the standalone sheet.
 *
 * Every edit asserts the version it read, so a field the user reaches for
 * while an agent is writing is refused rather than merged — and the refusal
 * says so. `usePatchItem` re-fetches on settle either way, so the retry is
 * made against a fresh version instead of the stale one that was just refused.
 */
export type IssueWrite = (item: Item, patch: Patch, said: ReactNode) => Promise<boolean>;

export function useIssueWriter(projectId: string): { write: IssueWrite; pending: boolean } {
  const patch = usePatchItem(projectId);
  const undoWrite = useToastUndo(projectId);
  const toast = useToast();
  const { tx } = useI18n();

  // mutateAsync, not mutate: per-call callbacks only fire for the latest call,
  // and a caller holding a draft needs to hear how its own write went.
  const write = useCallback<IssueWrite>(
    (item, next, said) =>
      patch.mutateAsync({ id: item.id, patch: next, baseVersion: item.version }).then(
        (written) => {
          toast({ body: said, onUndo: () => undoWrite({ id: item.id, stamp: written.version }) });
          return true;
        },
        // a refused edit that says nothing reads as an edit that silently did not happen
        (err: Error) => {
          toast({
            body: /conflict/i.test(err.message) ? tx("fields.conflictToast", { key: <span className="num">{item.key}</span> }) : err.message
          });
          return false;
        }
      ),
    [patch, toast, undoWrite, tx]
  );

  return { write, pending: patch.isPending };
}

export interface FieldProps {
  item: Item;
  write: IssueWrite;
}

/**
 * An editable enum reads as its own value and only looks like a control when
 * reached for. A native `<select>` is deliberate: the field strip renders
 * inside a Radix dialog when the pane is expanded, and an OS menu neither
 * fights that focus trap nor gets clipped by the overlay's rounded corners.
 */
function Picker({
  label,
  value,
  mark,
  options,
  onPick,
  minWidth
}: {
  label: string;
  value: string;
  mark?: ReactNode;
  options: { value: string; name: string }[];
  onPick: (value: string) => void;
  minWidth?: number;
}) {
  return (
    <span className="fset">
      {mark}
      <select className="fsel" style={minWidth ? { minWidth } : undefined} aria-label={label} value={value} onChange={(e) => onPick(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.name}
          </option>
        ))}
      </select>
      <Icon className="fchev" name="i-chevdown" size={11} aria-hidden />
    </span>
  );
}

export function StatusField({ item, write }: FieldProps) {
  const { t, tx } = useI18n();
  return (
    <Picker
      label={t("detailPane.fieldStatus")}
      value={item.status}
      mark={<StatusMark status={item.status} size={13} />}
      options={STATUS_KEYS.map((s) => ({ value: s, name: STATUS[s].label }))}
      onPick={(v) => {
        const next = v as ItemStatus;
        if (next === item.status) return;
        write(item, { status: next }, tx("fields.movedToStatusToast", { key: <span className="num">{item.key}</span>, status: STATUS[next].label }));
      }}
    />
  );
}

export function WorkTypeField({ item, write }: FieldProps) {
  const { t } = useI18n();
  return <Picker label={t("fields.workType")} value={item.workType} minWidth={90}
    options={[{ value: "coding", name: t("fields.coding") }, { value: "general", name: t("fields.general") }]}
    onPick={value => {
      if ((value !== "coding" && value !== "general") || value === item.workType) return;
      write(item, { workType: value }, t("fields.setWorkTypeToast", { key: item.key, type: t(`fields.${value}`) }));
    }} />;
}

export function PriorityField({ item, write }: FieldProps) {
  const { t, tx } = useI18n();
  return (
    <Picker
      label={t("detailPane.fieldPriority")}
      value={String(item.priority)}
      mark={<PriorityGlyph priority={item.priority} size={13} always />}
      options={PRIORITIES.map((p) => ({ value: String(p), name: PRIORITY_LABEL[p] }))}
      onPick={(v) => {
        const next = Number(v) as Priority;
        if (next === item.priority) return;
        write(item, { priority: next }, tx("fields.setPriorityToast", { key: <span className="num">{item.key}</span>, priority: PRIORITY_LABEL[next] }));
      }}
    />
  );
}

/** Epics are items, so the option value is an item id and "" means unparented. */
export function EpicField({ item, write, epics }: FieldProps & { epics: Item[] }) {
  const { t, tx } = useI18n();
  const candidates = epics.filter((e) => e.id !== item.id);
  return (
    <Picker
      label={t("fields.parentEpicLabel")}
      value={item.parentId ?? ""}
      mark={item.parentId ? <Icon name="i-stack" size={12} style={{ color: "var(--meta)" }} /> : undefined}
      options={[
        { value: "", name: t("common.none") },
        ...candidates.map((e) => ({ value: e.id, name: e.title })),
        // an epic deleted out from under us, or one this project cannot list
        ...(item.parentId && !candidates.some((e) => e.id === item.parentId) ? [{ value: item.parentId, name: t("detailPane.fieldEpic") }] : [])
      ]}
      onPick={(v) => {
        const next = v || null;
        if (next === item.parentId) return;
        const name = candidates.find((e) => e.id === next)?.title;
        write(
          item,
          { parentId: next },
          next
            ? tx("fields.linkedToast", { key: <span className="num">{item.key}</span>, name: name ?? t("fields.itsEpicFallback") })
            : tx("fields.unlinkedToast", { key: <span className="num">{item.key}</span> })
        );
      }}
    />
  );
}

/** The Workstream field: an issue belongs to exactly one, so there is no empty option. */
export function BoardField({ item, write, boards }: FieldProps & { boards: Board[] }) {
  const { t, tx } = useI18n();
  const workstreams = boards;
  return (
    <Picker
      label={t("detailPane.fieldBoard")}
      value={item.boardId}
      options={
        workstreams.some((b) => b.id === item.boardId)
          ? workstreams.map((b) => ({ value: b.id, name: b.name }))
          : [{ value: item.boardId, name: t("detailPane.fieldBoard") }, ...workstreams.map((b) => ({ value: b.id, name: b.name }))]
      }
      onPick={(v) => {
        if (v === item.boardId) return;
        const name = workstreams.find((b) => b.id === v)?.name ?? t("fields.anotherBoardFallback");
        write(item, { boardId: v }, tx("fields.movedToBoardToast", { key: <span className="num">{item.key}</span>, name }));
      }}
    />
  );
}

/**
 * Labels are a free vocabulary — the repository creates any name it has not
 * seen — so the field offers what the project already uses without refusing
 * anything new.
 */
export function LabelsField({ item, write, vocabulary }: FieldProps & { vocabulary: string[] }) {
  const { t, tx } = useI18n();
  const listId = useId();
  const [adding, setAdding] = useState(false);
  // Enter unmounts the input, and an unmount can still blur — `item` is a
  // closure over the pre-write issue, so a second add would not see the label
  // it just wrote and would write it again.
  const settled = useRef(false);
  const unused = vocabulary.filter((v) => !item.labels.includes(v));

  const add = (raw: string) => {
    setAdding(false);
    if (settled.current) return;
    settled.current = true;
    const name = raw.trim();
    if (!name || item.labels.includes(name)) return;
    write(item, { labels: [...item.labels, name].sort() }, tx("fields.addedLabelToast", { name: <b>{name}</b>, key: <span className="num">{item.key}</span> }));
  };

  const remove = (name: string) =>
    write(item, { labels: item.labels.filter((l) => l !== name) }, tx("fields.removedLabelToast", { name: <b>{name}</b>, key: <span className="num">{item.key}</span> }));

  return (
    <span className="labset">
      {item.labels.map((l) => (
        <span key={l} className="tag faint lab">
          {l}
          <button type="button" className="lab-x" aria-label={t("fields.removeLabelAria", { name: l })} title={t("fields.removeLabelTitle", { name: l })} onClick={() => remove(l)}>
            <Icon name="i-close" size={9} />
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            autoFocus
            className="lab-in"
            list={unused.length ? listId : undefined}
            aria-label={t("fields.newLabelAria")}
            placeholder={t("fields.labelPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(e.currentTarget.value);
              }
              if (e.key === "Escape") {
                // the expanded pane is a dialog; Escape belongs to this input first
                e.stopPropagation();
                settled.current = true;
                setAdding(false);
              }
            }}
            onBlur={(e) => add(e.currentTarget.value)}
          />
          {unused.length > 0 && (
            <datalist id={listId}>
              {unused.map((v) => (
                <option key={v} value={v} />
              ))}
            </datalist>
          )}
        </>
      ) : (
        <button
          type="button"
          className="lab-add"
          title={t("fields.addLabelTitle")}
          onClick={() => {
            settled.current = false;
            setAdding(true);
          }}
        >
          <Icon name="i-plus" size={10} /> {t("fields.labelButtonText")}
        </button>
      )}
    </span>
  );
}

/**
 * The lock is a human-only field: it stops agents writing title and body, so
 * only a human can set or clear it. Status stays agent-writable either way.
 */
export function LockButton({ item, write, className }: FieldProps & { className?: string }) {
  const { t, tx } = useI18n();
  const locked = item.humanLocked;
  return (
    <button
      type="button"
      className={cn("btn", className ?? "btn-ghost")}
      data-on={locked}
      aria-pressed={locked}
      title={locked ? t("fields.lockButtonUnlockTitle") : t("fields.lockButtonLockTitle")}
      onClick={() =>
        write(
          item,
          { humanLocked: !locked },
          locked
            ? tx("fields.unlockedToast", { key: <span className="num">{item.key}</span> })
            : tx("fields.lockedToast", { key: <span className="num">{item.key}</span> })
        )
      }
    >
      <Icon name="i-lock" size={13} />
      <span className="lbl">{locked ? t("fields.unlockLabel") : t("fields.lockLabel")}</span>
    </button>
  );
}

/**
 * Click-to-edit text. The read view is a button so the affordance is reachable
 * from a keyboard, and the write view is a textarea that grows to its content —
 * a wrapped title must not scroll inside two lines.
 *
 * Blur commits, because an edit abandoned by clicking elsewhere is still an
 * edit; Escape is the way to discard one.
 */
export function InlineText({
  value,
  placeholder,
  ariaLabel,
  className,
  heading,
  onSave
}: {
  value: string;
  placeholder: string;
  ariaLabel: string;
  /** Shared by both views, so the text does not reflow when it becomes editable. */
  className: string;
  /** Keeps the read view a real heading; the write view is always a textarea. */
  heading?: "h1" | "h2";
  /** False (or a promise of it) when the write was refused: the editor reopens holding what was typed. */
  onSave: (next: string) => void | boolean | "" | Promise<boolean>;
}) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  // what a refused save handed back, so the person can press Enter again instead of retyping
  const [kept, setKept] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  // Escape unmounts the textarea, and an unmount can still fire blur — without
  // this the discard would be committed by the very blur it caused.
  const discarded = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!editing || !el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editing]);

  const commit = (next: string) => {
    setEditing(false);
    if (discarded.current) {
      discarded.current = false;
      return;
    }
    const trimmed = next.trim();
    setKept(null);
    if (trimmed === value.trim()) return;
    void Promise.resolve(onSave(trimmed)).then((ok) => {
      if (ok !== false) return;
      setKept(trimmed);
      setEditing(true);
    });
  };

  if (!editing) {
    const view = (
      <button
        type="button"
        className={cn("inline-edit", !heading && className)}
        title={t("fields.clickToEdit")}
        onClick={() => {
          discarded.current = false;
          setEditing(true);
        }}
      >
        {value || <span className="inline-hint">{placeholder}</span>}
      </button>
    );
    if (heading === "h1") return <h1 className={className}>{view}</h1>;
    if (heading === "h2") return <h2 className={className}>{view}</h2>;
    return view;
  }

  return (
    <textarea
      ref={ref}
      rows={1}
      className={cn(className, "inline-ta")}
      aria-label={ariaLabel}
      placeholder={placeholder}
      defaultValue={kept ?? value}
      onInput={(e) => {
        e.currentTarget.style.height = "auto";
        e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          discarded.current = true;
          setKept(null);
          setEditing(false);
          return;
        }
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit(e.currentTarget.value);
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

/** The title, wired to the write path. The lock never blocks a human. */
export function IssueTitle({ item, write, heading }: FieldProps & { heading: "h1" | "h2" }) {
  const { t, tx } = useI18n();
  return (
    <InlineText
      value={item.title}
      placeholder={t("fields.untitledIssue")}
      ariaLabel={t("fields.issueTitleAria")}
      className={heading === "h1" ? "issue-title" : "detail-title"}
      heading={heading}
      onSave={(next) => next && write(item, { title: next }, tx("fields.retitledToast", { key: <span className="num">{item.key}</span> }))}
    />
  );
}

/** Ids reachable from `start` along `blocks` edges, `start` excluded. */
function reachableFrom(start: string, items: Item[]): Set<string> {
  const blocksOf = new Map(items.map((i) => [i.id, i.blocks]));
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length) {
    for (const next of blocksOf.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * One edge list, editable from either end. `blockedBy` edits write to the
 * *other* issue — the edge is stored on the blocker — which is why every chip
 * and toast still names both sides. Candidates that would close a cycle are
 * not offered; the service refuses them anyway, this just keeps the datalist
 * honest.
 */
export function DepsField({ item, write, items, mode, onOpen }: FieldProps & { items: Item[]; mode: "blocks" | "blockedBy"; onOpen: (id: string) => void }) {
  const { t, tx } = useI18n();
  const listId = useId();
  const [adding, setAdding] = useState(false);
  const settled = useRef(false);

  const related = mode === "blocks" ? item.blocks.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i) : items.filter((i) => i.blocks.includes(item.id));
  const relatedIds = new Set(related.map((r) => r.id));
  // For "blocks", a candidate that reaches this issue would close a loop; for
  // "blocked by", one this issue reaches would.
  const looped = mode === "blocks" ? (c: Item) => reachableFrom(c.id, items).has(item.id) : (c: Item) => reachableFrom(item.id, items).has(c.id);
  const candidates = items.filter((c) => isTicket(c) && c.id !== item.id && !relatedIds.has(c.id) && !looped(c));

  const said = (verbKey: "fields.addedBlocksToast" | "fields.removedBlocksToast" | "fields.addedBlockedByToast" | "fields.removedBlockedByToast", other: Item) =>
    tx(verbKey, { key: <span className="num">{item.key}</span>, other: <span className="num">{other.key}</span> });

  const add = (raw: string) => {
    setAdding(false);
    if (settled.current) return;
    settled.current = true;
    const text = raw.trim();
    if (!text) return;
    const keyPart = text.split(" ")[0];
    const target = candidates.find((c) => c.key === keyPart) ?? candidates.find((c) => c.title === text);
    if (!target) return;
    if (mode === "blocks") write(item, { blocks: [...item.blocks, target.id] }, said("fields.addedBlocksToast", target));
    else write(target, { blocks: [...target.blocks, item.id] }, said("fields.addedBlockedByToast", target));
  };

  const remove = (other: Item) => {
    if (mode === "blocks") write(item, { blocks: item.blocks.filter((id) => id !== other.id) }, said("fields.removedBlocksToast", other));
    else write(other, { blocks: other.blocks.filter((id) => id !== item.id) }, said("fields.removedBlockedByToast", other));
  };

  return (
    <span className="labset">
      {related.map((r) => (
        <span key={r.id} className="tag faint lab dep">
          <button type="button" className="dep-open" title={r.title} onClick={() => onOpen(r.id)}>
            <StatusMark status={r.status} size={11} />
            <span className="num">{r.key}</span>
          </button>
          <button type="button" className="lab-x" aria-label={t("fields.removeDepAria", { key: r.key })} title={t("fields.removeDepTitle", { key: r.key })} onClick={() => remove(r)}>
            <Icon name="i-close" size={9} />
          </button>
        </span>
      ))}
      {adding ? (
        <>
          <input
            autoFocus
            className="lab-in dep-in"
            list={candidates.length ? listId : undefined}
            aria-label={t(mode === "blocks" ? "fields.newBlocksAria" : "fields.newBlockedByAria")}
            placeholder={t("fields.depPlaceholder")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add(e.currentTarget.value);
              }
              if (e.key === "Escape") {
                // the expanded pane is a dialog; Escape belongs to this input first
                e.stopPropagation();
                settled.current = true;
                setAdding(false);
              }
            }}
            onBlur={(e) => add(e.currentTarget.value)}
          />
          {candidates.length > 0 && (
            <datalist id={listId}>
              {candidates.map((c) => (
                <option key={c.id} value={`${c.key} ${c.title}`} />
              ))}
            </datalist>
          )}
        </>
      ) : (
        <button
          type="button"
          className="lab-add"
          title={t(mode === "blocks" ? "fields.addBlocksTitle" : "fields.addBlockedByTitle")}
          onClick={() => {
            settled.current = false;
            setAdding(true);
          }}
        >
          <Icon name="i-plus" size={10} /> {t("fields.depButtonText")}
        </button>
      )}
    </span>
  );
}

/**
 * Free text or a number, edited in place. Blur commits, Escape discards, Enter
 * commits — the same contract as `InlineText`, on one line.
 */
function InlineValue({ value, kind, label, onSave }: { value: string; kind: "text" | "number"; label: string; onSave: (next: string) => void }) {
  const discarded = useRef(false);
  const commit = (next: string) => {
    if (discarded.current) {
      discarded.current = false;
      return;
    }
    if (next.trim() === value) return;
    onSave(next.trim());
  };
  return (
    <input
      key={value}
      className={cn("fval", kind === "number" && "num")}
      type={kind === "number" ? "number" : "text"}
      step={kind === "number" ? "any" : undefined}
      inputMode={kind === "number" ? "decimal" : undefined}
      aria-label={label}
      defaultValue={value}
      placeholder="—"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          discarded.current = true;
          e.currentTarget.value = value;
          e.currentTarget.blur();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => commit(e.currentTarget.value)}
    />
  );
}

/**
 * One editor for every custom field, chosen by type. Each edit is a `fields`
 * patch through the same write path as a built-in, so the version, the oplog,
 * the lock policy and undo all apply unchanged.
 */
export function CustomField({ item, write, def }: FieldProps & { def: FieldDef }) {
  const { t, tx } = useI18n();
  const current = item.fields[def.id] ?? null;
  const set = (next: FieldValue | null) => {
    if (next === current) return;
    write(
      item,
      { fields: { [def.id]: next } },
      next === null
        ? tx("fields.clearedFieldToast", { name: <b>{def.name}</b>, key: <span className="num">{item.key}</span> })
        : tx("fields.setFieldToast", { name: <b>{def.name}</b>, key: <span className="num">{item.key}</span> })
    );
  };

  switch (def.type) {
    case "select":
      return (
        <Picker
          label={def.name}
          value={typeof current === "string" ? current : ""}
          options={[
            { value: "", name: t("common.none") },
            ...def.options.map((o) => ({ value: o.id, name: o.name })),
            // an option removed out from under this item; the value still reads
            ...(typeof current === "string" && !def.options.some((o) => o.id === current) ? [{ value: current, name: t("fields.missingOption") }] : [])
          ]}
          onPick={(v) => set(v || null)}
        />
      );
    case "date":
      return (
        <input
          className="fval num"
          type="date"
          aria-label={def.name}
          value={typeof current === "string" ? current : ""}
          onChange={(e) => set(e.currentTarget.value || null)}
        />
      );
    case "number":
      return (
        <InlineValue
          kind="number"
          label={def.name}
          value={current === null ? "" : String(current)}
          onSave={(next) => {
            if (!next) return set(null);
            const n = Number(next);
            if (Number.isFinite(n)) set(n);
          }}
        />
      );
    default:
      return <InlineValue kind="text" label={def.name} value={current === null ? "" : String(current)} onSave={(next) => set(next || null)} />;
  }
}
