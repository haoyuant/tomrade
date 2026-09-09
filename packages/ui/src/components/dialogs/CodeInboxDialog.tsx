import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { useAdoptBranch, useProposals, useRescan, useResolveProposal, useUnlinkedBranches } from "~/lib/codeLink";
import { STATUS, agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useItems } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/**
 * What git says that the backlog does not yet: status changes the scanner
 * would not make on its own, and branches that name no ticket. Each row has
 * the one action that settles it.
 */
export function CodeInboxDialog({ projectId, open, onOpenChange, onOpenIssue }: { projectId: string; open: boolean; onOpenChange: (open: boolean) => void; onOpenIssue: (id: string) => void }) {
  const { t } = useI18n();
  const toast = useToast();
  const items = useItems(projectId);
  const proposals = useProposals(projectId);
  const unlinked = useUnlinkedBranches(projectId);
  const resolve = useResolveProposal(projectId);
  const adopt = useAdoptBranch(projectId);
  const rescan = useRescan(projectId);
  const byId = new Map((items.data ?? []).map((i) => [i.id, i]));
  const pending = proposals.data ?? [];
  const branches = unlinked.data ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("codeLink.inboxTitle")}>
      <DialogHead
        title={t("codeLink.inboxTitle")}
        aside={
          <button
            type="button"
            className="btn btn-secondary"
            disabled={rescan.isPending}
            onClick={() => rescan.mutate(undefined, { onSuccess: (s) => toast({ body: t("codeLink.rescanned", { scanned: s.scanned, repos: s.repos, moved: s.changed }) }), onError: (e) => toast({ body: e.message }) })}
          >
            {rescan.isPending ? t("codeLink.scanning") : t("codeLink.rescan")}
          </button>
        }
      />
      <DialogBody>
        <Eyebrow style={{ marginBottom: "var(--space-2)" }}>{t("codeLink.proposalsHeading")}</Eyebrow>
        {pending.length === 0 && <p className="meta-txt">{t("codeLink.noProposals")}</p>}
        <div className="inbox-list">
          {pending.map((p) => {
            const item = byId.get(p.itemId);
            return (
              <div className="inbox-row" key={p.id} data-testid="code-proposal">
                <div className="inbox-main">
                  <button type="button" className="link-btn num" onClick={() => onOpenIssue(p.itemId)}>
                    {item?.key ?? p.itemId}
                  </button>
                  <span className="inbox-title">{item?.title ?? ""}</span>
                  <span className="meta-txt">{p.kind === "flag" ? `⚠ ${p.reason}` : `${STATUS[p.fromStatus].label} → ${p.toStatus ? STATUS[p.toStatus].label : ""} · ${p.reason}`}</span>
                </div>
                <div className="inbox-actions">
                  {p.kind === "propose" && p.toStatus && (
                    <button type="button" className="btn btn-primary" disabled={resolve.isPending} onClick={() => resolve.mutate({ proposalId: p.id, accept: true }, { onError: (e) => toast({ body: e.message }) })}>
                      {t("codeLink.accept", { status: STATUS[p.toStatus].label })}
                    </button>
                  )}
                  <button type="button" className="btn btn-ghost" disabled={resolve.isPending} onClick={() => resolve.mutate({ proposalId: p.id, accept: false }, { onError: (e) => toast({ body: e.message }) })}>
                    {t("codeLink.dismiss")}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        <Eyebrow style={{ margin: "var(--space-5) 0 var(--space-2)" }}>{t("codeLink.unlinkedHeading")}</Eyebrow>
        {branches.length === 0 && <p className="meta-txt">{t("codeLink.noUnlinked")}</p>}
        <div className="inbox-list">
          {branches.map((b) => (
            <div className="inbox-row" key={`${b.repoId}:${b.branch}`} data-testid="unlinked-branch">
              <div className="inbox-main">
                <span className="num">{b.branch}</span>
                <span className="meta-txt">
                  <Tag tone="faint">{b.repoName}</Tag> {agoLabel(b.committedAt)}
                </span>
              </div>
              <div className="inbox-actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={adopt.isPending}
                  onClick={() => adopt.mutate({ repoId: b.repoId, branch: b.branch }, { onSuccess: (item) => toast({ body: t("codeLink.adopted", { key: item.key }) }), onError: (e) => toast({ body: e.message }) })}
                >
                  <Icon name="i-plus" size={13} /> {t("codeLink.createTicket")}
                </button>
              </div>
            </div>
          ))}
        </div>
      </DialogBody>
    </Dialog>
  );
}
