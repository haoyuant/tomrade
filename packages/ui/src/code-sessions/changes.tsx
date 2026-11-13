import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChangesDialog } from "~/components/diff/TicketChanges";
import type { ChangesSource } from "~/lib/changes";
import { LocaleWords, useI18n } from "~/lib/i18n";
import { changeReview, onChangeReviewChanged, onState, openChanged, readChangeFile, readChanges } from "./bridge";

/** The ticket whose changes the window shows over its cells; one at a time. */
interface Shown {
  itemId: string;
  key: string | null;
}

let shown: Shown | null = null;
const listeners = new Set<() => void>();
const set = (next: Shown | null) => {
  shown = next;
  for (const listener of listeners) listener();
};

/** Opens a ticket's changes over the cells, from any cell's bar. */
export const showChanges = (itemId: string, key: string | null) => set({ itemId, key });

/** The least time between two reads of an open diff as the window's state moves. */
const REREAD_MS = 2000;

const sourceOf = (itemId: string): ChangesSource => ({
  key: ["changes", itemId],
  changes: (opts) => readChanges(itemId, opts),
  file: (opts) => readChangeFile(itemId, opts),
  open: (opts) => openChanged(itemId, opts),
  commentsKey: ["changeComments", itemId],
  comments: () => changeReview(itemId, { op: "comments" }),
  addComment: (draft) => changeReview(itemId, { op: "add", draft }),
  editComment: (id, edit) => changeReview(itemId, { op: "edit", id, edit }),
  removeComment: (id) => changeReview(itemId, { op: "remove", id }),
  reviewTarget: () => changeReview(itemId, { op: "target" }),
  sendComments: (opts) => changeReview(itemId, { op: "send", deliver: opts?.deliver }),
  markReviewed: (opts) => changeReview(itemId, { op: "markReviewed", linkId: opts?.linkId }),
  reviewers: () => changeReview(itemId, { op: "reviewers" }),
  reviews: () => changeReview(itemId, { op: "reviews" }),
  startReview: (opts) => changeReview(itemId, { op: "review", engine: opts?.engine }),
  releaseReview: () => changeReview(itemId, { op: "release" })
});

function Sheet({ target, onNotice }: { target: Shown; onNotice: (text: string) => void }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const source = useMemo(() => sourceOf(target.itemId), [target.itemId]);
  // The window hears its sessions' hooks as state: the nearest thing to hearing the working tree change.
  useEffect(() => {
    let last = 0;
    return onState(() => {
      if (Date.now() - last < REREAD_MS) return;
      last = Date.now();
      void qc.invalidateQueries({ queryKey: source.key });
    });
  }, [qc, source]);
  useEffect(() => onChangeReviewChanged((itemId) => itemId === target.itemId && void qc.invalidateQueries({ queryKey: source.commentsKey })), [qc, source, target.itemId]);
  return <ChangesDialog open onOpenChange={(open) => !open && set(null)} title={target.key ? t("diff.sheetTitle", { key: target.key }) : t("diff.title")} source={source} viewedKey={target.itemId} onNotice={onNotice} />;
}

/** The diff a cell's session opens, in the window's language. Mounted once. */
export function SessionChanges({ locale, onNotice }: { locale: string; onNotice: (text: string) => void }) {
  const target = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => shown
  );
  if (!target) return null;
  return (
    <LocaleWords locale={locale}>
      <Sheet key={target.itemId} target={target} onNotice={onNotice} />
    </LocaleWords>
  );
}
