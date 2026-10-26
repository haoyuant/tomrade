import { useState } from "react";
import { Icon } from "~/components/icons";
import { Menu, MenuHead, MenuRadioItem } from "~/components/ui/menu";
import { useArchivedThreads, useUnarchiveThread, type useAgentThreads } from "~/lib/agent";
import type { AttentionEntry } from "~/lib/attention";
import { clockLabel, timeAgo } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";

/** Kept by the panel, so the searches and the view stay as they were while it is collapsed. */
export function useThreadListState(projectId: string) {
  const [query, setQuery] = useState("");
  const [archivedQuery, setArchivedQuery] = useState("");
  const [view, setView] = useState<"threads" | "archived">("threads");
  const archived = useArchivedThreads(projectId, view === "archived");
  const unarchive = useUnarchiveThread(projectId);
  return { query, setQuery, archivedQuery, setArchivedQuery, view, setView, archived, unarchive };
}

function ThreadSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  return (
    <div className="menu-search">
      <input
        className="input"
        type="search"
        aria-label={t("agentPanel.searchThreads")}
        placeholder={t("agentPanel.searchThreads")}
        value={value}
        // the menu's typeahead would take the keys otherwise
        onKeyDown={(e) => e.stopPropagation()}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}

const matching = <T extends { title: string }>(list: T[], query: string) => {
  const term = query.trim().toLowerCase();
  return list.filter((th) => !term || (th.title || "").toLowerCase().includes(term));
};

/** The list: searchable once it is long, with what is running or waiting said beside each, and the archive a second view of the same menu. */
export function ThreadList({ state, threads, threadId, attentionOf, attentionLabel, onPick, onNew, onArchive, onDelete }: {
  state: ReturnType<typeof useThreadListState>;
  threads: ReturnType<typeof useAgentThreads>["data"];
  threadId: string | null;
  attentionOf: Map<string, AttentionEntry>;
  attentionLabel: (e: AttentionEntry) => string;
  onPick: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const { t } = useI18n();
  const { query: threadQuery, setQuery: setThreadQuery, archivedQuery, setArchivedQuery, view, setView, archived, unarchive } = state;
  const matchingThreads = matching(threads ?? [], threadQuery);
  const archivedThreads = archived.data ?? [];
  const matchingArchived = matching(archivedThreads, archivedQuery);
  return (
    <Menu
      label={t("agentPanel.threadsLabel")}
      align="end"
      trigger={
        <button type="button" className="btn btn-icon" title={t("agentPanel.threadsLabel")} aria-label={t("agentPanel.threadsLabel")}>
          <Icon name="i-stack" size={14} />
        </button>
      }
    >
      {view === "archived" ? (
        <>
          <MenuHead
            title={t("agentPanel.archivedLabel")}
            aside={
              <button type="button" className="btn btn-icon" title={t("agentPanel.backToThreads")} aria-label={t("agentPanel.backToThreads")} onClick={() => setView("threads")}>
                <Icon name="i-back" size={13} />
              </button>
            }
          />
          {archivedThreads.length > 6 && <ThreadSearch value={archivedQuery} onChange={setArchivedQuery} />}
          {archived.isSuccess && archivedThreads.length === 0 && <p className="meta-txt dense menu-note">{t("agentPanel.noArchived")}</p>}
          {archivedQuery.trim() && archivedThreads.length > 0 && matchingArchived.length === 0 && <p className="meta-txt dense menu-note">{t("agentPanel.noThreadsMatch")}</p>}
          {matchingArchived.length > 30 && <p className="meta-txt dense menu-note">{t("agentPanel.moreThreads", { n: matchingArchived.length - 30 })}</p>}
          {matchingArchived.slice(0, 30).map((th) => (
            <MenuRadioItem
              key={th.id}
              checked={false}
              name={th.title || t("agentPanel.newThread")}
              chips={th.origins}
              sub={timeAgo(th.updatedAt)}
              onSelect={() =>
                unarchive.mutate(th.id, {
                  onSuccess: () => {
                    setView("threads");
                    onPick(th.id);
                  }
                })
              }
              actions={
                <button type="button" className="btn btn-icon" title={t("agentPanel.restoreThread")} aria-label={t("agentPanel.restoreThread")} onClick={() => unarchive.mutate(th.id)}>
                  <Icon name="i-undo" size={12} />
                </button>
              }
            />
          ))}
        </>
      ) : (
        <>
          <MenuHead
            title={t("agentPanel.threadsLabel")}
            aside={
              <>
                <button type="button" className="btn btn-icon" title={t("agentPanel.showArchived")} aria-label={t("agentPanel.showArchived")} onClick={() => setView("archived")}>
                  <Icon name="i-archive" size={13} />
                </button>
                <button type="button" className="btn btn-icon" title={t("agentPanel.newThread")} aria-label={t("agentPanel.newThread")} onClick={onNew}>
                  <Icon name="i-plus" size={13} />
                </button>
              </>
            }
          />
          {(threads?.length ?? 0) > 6 && <ThreadSearch value={threadQuery} onChange={setThreadQuery} />}
          {threadQuery.trim() && matchingThreads.length === 0 && <p className="meta-txt dense menu-note">{t("agentPanel.noThreadsMatch")}</p>}
          {matchingThreads.length > 30 && <p className="meta-txt dense menu-note">{t("agentPanel.moreThreads", { n: matchingThreads.length - 30 })}</p>}
          {matchingThreads.slice(0, 30).map((th) => (
            <MenuRadioItem
              key={th.id}
              checked={th.id === threadId}
              name={th.title || t("agentPanel.newThread")}
              chips={th.origins}
              sub={[attentionOf.has(th.id) ? attentionLabel(attentionOf.get(th.id)!) : th.running ? t("agentPanel.threadRunning") : th.parkedUntil ? t("agentPanel.parkedUntil", { time: clockLabel(th.parkedUntil) }) : null, timeAgo(th.updatedAt)].filter(Boolean).join(" · ")}
              onSelect={() => onPick(th.id)}
              actions={
                <>
                  <button type="button" className="btn btn-icon" title={t("agentPanel.archiveThread")} aria-label={t("agentPanel.archiveThread")} onClick={() => onArchive(th.id)}>
                    <Icon name="i-archive" size={12} />
                  </button>
                  <button type="button" className="btn btn-icon" title={t("agentPanel.deleteThread")} aria-label={t("agentPanel.deleteThread")} onClick={() => onDelete(th.id)}>
                    <Icon name="i-trash" size={12} />
                  </button>
                </>
              }
            />
          ))}
        </>
      )}
    </Menu>
  );
}
