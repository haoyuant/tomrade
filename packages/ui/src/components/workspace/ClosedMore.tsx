import type { ClosedStatus } from "@tomradex/domain";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "./context";

/** The foot of a closed column: what it does not hold yet, and the way to the next page. */
export function LoadMore({ statuses, text }: { statuses: ClosedStatus[]; text: (n: number) => string }) {
  const { t } = useI18n();
  const { closed } = useWorkspace();
  const n = statuses.reduce((sum, status) => sum + closed.hidden(status), 0);
  if (n === 0) return null;
  const loading = statuses.some(closed.loading);
  return (
    <p className="col-more meta-txt dense" data-testid="closed-more">
      <span className="num">{text(n)}</span>
      {" · "}
      <button type="button" className="link-btn" disabled={loading} onClick={() => closed.loadMore(statuses)}>
        {loading ? t("board.loadingMore") : t("board.loadMore")}
      </button>
    </p>
  );
}
