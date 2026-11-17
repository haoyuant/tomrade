import { useState } from "react";
import type { WorktreeHold, WorktreeView } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { FoldChevron, FoldChevronSpace, StatusMark } from "~/components/ui/atoms";
import { WORKTREE_HOLD_KEY, diskSize, removalSummary, useRemoveWorktrees, useWorktreeSizes, useWorktrees, worktreeCanGo, worktreeState } from "~/lib/codeLink";
import { useConfirm } from "~/lib/confirm";
import { intlTag, useI18n } from "~/lib/i18n";
import { reveal, revealLabel } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { message } from "./destination";

/**
 * The worktrees Tomrade made for this repository on this machine: whose each is, what it takes on disk, and why it
 * is still there. Finished tickets' go by themselves; here a person removes them sooner, or one at a time.
 */
export function RepoWorktrees({ projectId, repoId }: { projectId: string; repoId: string }) {
  const { t } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // What can go comes first; the rest in the order of their tickets.
  const listed = useWorktrees(projectId);
  const trees = (listed.data ?? [])
    .filter((tree) => tree.repoId === repoId)
    .sort((a, b) => Number(!worktreeCanGo(a)) - Number(!worktreeCanGo(b)) || (a.tickets[0]?.key ?? "~").localeCompare(b.tickets[0]?.key ?? "~", undefined, { numeric: true }));
  const sizes = useWorktreeSizes(trees.map((tree) => ({ projectId, dir: tree.dir })), open);
  const remove = useRemoveWorktrees();
  // Said even when there are none, so the list is found before a disk fills; nothing is said until git has answered.
  if (!listed.data) return null;
  const none = trees.length === 0;

  const finished = trees.filter(worktreeCanGo);
  const known = trees.flatMap((tree) => sizes.get(tree.dir) ?? []);

  const take = (dirs: string[], strays = false) =>
    remove.mutate([{ projectId, dirs, strays }], {
      onSuccess: (removals) => {
        const { removed, kept, reason } = removalSummary(removals);
        const why = reason && reason in WORKTREE_HOLD_KEY ? t(WORKTREE_HOLD_KEY[reason as WorktreeHold]) : (reason ?? "");
        toast({ body: kept ? t("repositories.worktreesKeptToast", { n: removed, kept, reason: why }) : t("repositories.worktreesRemovedToast", { n: removed }) });
      },
      onError: (error) => toast({ body: message(error) })
    });

  return (
    <>
      <div className="fold-row repo-worktrees" data-testid="repo-worktrees">
        {none ? <FoldChevronSpace /> : <FoldChevron open={open} label={t(open ? "repositories.worktreesHide" : "repositories.worktreesShow")} onToggle={() => setOpen((v) => !v)} />}
        <div className="cfg-row" style={{ marginTop: 0 }}>
          <Icon name="i-folder" size={14} style={{ color: "var(--meta)" }} />
          <span className="repo-remote-copy">
            <span className="cfg-name">{none ? t("repositories.worktreesNone") : t("repositories.worktrees", { n: trees.length })}</span>
            {!none && (
              <span className="meta-txt repo-remote-detail">
                {t("repositories.worktreesFinished", { n: finished.length })}
                {open && known.length === trees.length ? ` · ${diskSize(known.reduce((sum, bytes) => sum + bytes, 0))}` : ""}
              </span>
            )}
          </span>
          {!none && (
            <button type="button" className="btn btn-secondary repo-worktrees-clear" disabled={!finished.length || remove.isPending} onClick={() => take(finished.map((tree) => tree.dir))}>
              {remove.isPending ? t("repositories.worktreesRemoving") : t("repositories.worktreesRemoveFinished")}
            </button>
          )}
        </div>
      </div>
      {open && !none && (
        <div className="fold-row-body stack-2 repo-worktree-list">
          {trees.map((tree) => (
            <WorktreeRow key={tree.dir} tree={tree} size={sizes.get(tree.dir)} busy={remove.isPending} onRemove={() => take([tree.dir], tree.stray)} />
          ))}
        </div>
      )}
      <p className="meta-txt dense">{t("repositories.worktreesNote")}</p>
    </>
  );
}

/**
 * One worktree: whose it is, its branch and why it is still there, what it takes, and Remove when nothing holds it.
 * A stray — git no longer knows it — says so in place of a branch, and asks before it is removed. `where` names its
 * repository where the list spans several.
 */
export function WorktreeRow({ tree, size, where, busy, onRemove }: { tree: WorktreeView; size: number | null | undefined; where?: string; busy: boolean; onRemove: () => void }) {
  const { t, locale } = useI18n();
  const confirm = useConfirm();
  const ticket = tree.tickets[0];
  const state = worktreeState(tree, Date.now());
  const when = new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium", timeStyle: "short" });
  return (
    <div className="cfg-row repo-worktree" data-hold={tree.hold ?? "none"} data-stray={tree.stray || undefined} data-dir={tree.dir} style={{ marginTop: 0 }}>
      <span className="repo-remote-copy">
        {ticket ? (
          <span className="cfg-name repo-worktree-ticket" title={`${ticket.key} ${ticket.title}`}>
            <StatusMark status={ticket.status} />
            <span className="num">{ticket.key}</span>
            <span className="repo-worktree-title">
              {ticket.title}
              {tree.tickets.length > 1 ? ` +${tree.tickets.length - 1}` : ""}
            </span>
          </span>
        ) : (
          <span className="cfg-name">{t(tree.owner === "conversation" ? "repositories.worktreeConversation" : "repositories.worktreeNobody")}</span>
        )}
        <span className="meta-txt repo-worktree-state" title={tree.dir}>
          {where ? `${where} · ` : ""}
          {tree.stray ? t("repositories.worktreeStray") : <span className="num">{tree.branch ?? t("repositories.worktreeDetached")}</span>} · {t(state.key, state.at ? { when: when.format(state.at) } : undefined)}
        </span>
      </span>
      <span className="meta-txt num repo-worktree-size">{size === undefined ? "…" : size === null ? "" : diskSize(size)}</span>
      <button type="button" className="btn btn-ghost" onClick={() => reveal(tree.dir)}>
        {t(revealLabel())}
      </button>
      {!tree.hold && (
        <button
          type="button"
          className="btn btn-ghost repo-worktree-remove"
          disabled={busy}
          onClick={async () => {
            if (!tree.stray || (await confirm({ body: t("repositories.worktreeStrayConfirm", { dir: tree.dir }), yes: t("common.remove") }))) onRemove();
          }}
        >
          {t("common.remove")}
        </button>
      )}
    </div>
  );
}
