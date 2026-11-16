import { useState } from "react";
import type { WorktreeHold } from "@tomradex/code-link";
import { Icon } from "~/components/icons";
import { FoldChevron, StatusMark } from "~/components/ui/atoms";
import { WORKTREE_HOLD_KEY, diskSize, removalSummary, useRemoveWorktrees, useWorktreeSizes, useWorktrees, worktreeState } from "~/lib/codeLink";
import { intlTag, useI18n } from "~/lib/i18n";
import { reveal, revealLabel } from "~/lib/shell";
import { useToast } from "~/lib/toast";
import { message } from "./destination";

/**
 * The worktrees Tomrade made for this repository on this machine: whose each is, what it takes on disk, and why it
 * is still there. Finished tickets' go by themselves; here a person removes them sooner, or one at a time.
 */
export function RepoWorktrees({ projectId, repoId }: { projectId: string; repoId: string }) {
  const { t, locale } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // What can go comes first; the rest in the order of their tickets.
  const trees = (useWorktrees(projectId).data ?? [])
    .filter((tree) => tree.repoId === repoId)
    .sort((a, b) => Number(!!a.hold) - Number(!!b.hold) || (a.tickets[0]?.key ?? "~").localeCompare(b.tickets[0]?.key ?? "~", undefined, { numeric: true }));
  const sizes = useWorktreeSizes(projectId, trees.map((tree) => tree.dir), open);
  const remove = useRemoveWorktrees(projectId);
  if (!trees.length) return null;

  const finished = trees.filter((tree) => tree.owner === "ticket" && !tree.hold);
  const known = trees.flatMap((tree) => sizes.get(tree.dir) ?? []);
  const when = new Intl.DateTimeFormat(intlTag(locale), { dateStyle: "medium", timeStyle: "short" });
  const now = Date.now();

  const take = (dirs: string[]) =>
    remove.mutate(dirs, {
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
        <FoldChevron open={open} label={t(open ? "repositories.worktreesHide" : "repositories.worktreesShow")} onToggle={() => setOpen((v) => !v)} />
        <div className="cfg-row" style={{ marginTop: 0 }}>
          <Icon name="i-folder" size={14} style={{ color: "var(--meta)" }} />
          <span className="repo-remote-copy">
            <span className="cfg-name">{t("repositories.worktrees", { n: trees.length })}</span>
            <span className="meta-txt repo-remote-detail">
              {t("repositories.worktreesFinished", { n: finished.length })}
              {open && known.length === trees.length ? ` · ${diskSize(known.reduce((sum, bytes) => sum + bytes, 0))}` : ""}
            </span>
          </span>
          <button type="button" className="btn btn-secondary repo-worktrees-clear" disabled={!finished.length || remove.isPending} onClick={() => take(finished.map((tree) => tree.dir))}>
            {remove.isPending ? t("repositories.worktreesRemoving") : t("repositories.worktreesRemoveFinished")}
          </button>
        </div>
      </div>
      {open && (
        <div className="fold-row-body stack-2 repo-worktree-list">
          {trees.map((tree) => {
            const ticket = tree.tickets[0];
            const state = worktreeState(tree, now);
            const size = sizes.get(tree.dir);
            return (
              <div className="cfg-row repo-worktree" key={tree.dir} data-hold={tree.hold ?? "none"} style={{ marginTop: 0 }}>
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
                    <span className="num">{tree.branch ?? t("repositories.worktreeDetached")}</span> · {t(state.key, state.at ? { when: when.format(state.at) } : undefined)}
                  </span>
                </span>
                <span className="meta-txt num repo-worktree-size">{size === undefined ? "…" : size === null ? "" : diskSize(size)}</span>
                <button type="button" className="btn btn-ghost" onClick={() => reveal(tree.dir)}>
                  {t(revealLabel())}
                </button>
                {!tree.hold && (
                  <button type="button" className="btn btn-ghost repo-worktree-remove" disabled={remove.isPending} onClick={() => take([tree.dir])}>
                    {t("common.remove")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <p className="meta-txt dense">{t("repositories.worktreesNote")}</p>
    </>
  );
}
