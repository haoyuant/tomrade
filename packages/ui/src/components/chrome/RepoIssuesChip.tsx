import { useRepoStates } from "~/lib/codeLink";
import { useI18n } from "~/lib/i18n";

/**
 * The status bar's note that a repository's origin cannot be reached from this machine, from the
 * last check — it asks nothing of the network. Clicking goes to where each one can be checked again.
 */
export function RepoIssuesChip({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const { t } = useI18n();
  const broken = (useRepoStates(projectId).data ?? []).filter((r) => r.remote === "unreachable");
  if (!broken.length) return null;
  return (
    <button type="button" className="status-item status-link status-needs" data-testid="repo-issues-chip" title={t("repoIssues.chipTitle")} onClick={onOpen}>
      <span className="needs-dot" aria-hidden /> {t("repoIssues.chip", { n: broken.length })}
    </button>
  );
}
