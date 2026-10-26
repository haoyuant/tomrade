import { useState } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useBoards, useRepoCheckouts, useRepos } from "~/lib/queries";
import { unplacedWorkstreams } from "~/lib/remotes";

/**
 * A project brought to this machine (synced, restored) can have workstreams whose repository was
 * never placed here: their tickets cannot start, so the board says so before Start is pressed.
 */
export function UnplacedRepoBanner({ projectId, onOpenRepositories }: { projectId: string; onOpenRepositories: () => void }) {
  const { t } = useI18n();
  const boards = useBoards(projectId);
  const repos = useRepos(projectId);
  const checkouts = useRepoCheckouts();
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (!boards.data || !repos.data || !checkouts.data) return null;
  const unplaced = unplacedWorkstreams(boards.data, repos.data, checkouts.data);
  // Dismissed for what it said: a workstream that loses its folder later is said again.
  const said = unplaced.map((u) => u.board.id).join(",");
  if (!unplaced.length || dismissed === said) return null;
  const text =
    unplaced.length === 1
      ? t("workspace.unplacedOne", { board: unplaced[0]!.board.name, repo: unplaced[0]!.repo.name })
      : t("workspace.unplacedMany", { n: unplaced.length, list: unplaced.map((u) => u.board.name).join(", ") });
  return (
    <div className="banner" role="status" data-testid="unplaced-repo-banner">
      <Icon className="b-mark" name="i-warn" size={15} />
      <span>{text}</span>
      <button type="button" className="btn btn-secondary" style={{ marginLeft: "auto", padding: "3px 8px", flexShrink: 0 }} data-testid="unplaced-repo-fix" onClick={onOpenRepositories}>
        {t("workspace.unplacedFix")}
      </button>
      <button type="button" className="btn btn-ghost" style={{ padding: "3px 8px", flexShrink: 0 }} onClick={() => setDismissed(said)}>
        {t("workspace.dismiss")}
      </button>
    </div>
  );
}
