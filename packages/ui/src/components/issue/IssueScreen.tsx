import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Item, ItemStatus } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { DeleteIssueDialog } from "~/components/dialogs/DeleteIssueDialog";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { usePanelOpen } from "~/lib/panel";
import { AgentPanel, aiOpenKey } from "~/components/workspace/AgentPanel";
import { Eyebrow, Spacer, StatusMark } from "~/components/ui/atoms";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { LedgerRow, PluginSections } from "~/components/workspace/DetailPane";
import {
  BoardField,
  EpicField,
  IssueBody,
  IssueTitle,
  LabelsField,
  LockButton,
  PriorityField,
  StatusField,
  useIssueWriter
} from "~/components/issue/fields";
import { PROVENANCE, STATUS, agoLabel, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useBoards, useHistory, useItems, useLabels, useUndo } from "~/lib/queries";

/** backlog → todo → doing → verifying → done. The header offers the next step. */
const FLOW: ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done"];
const nextStatus = (status: ItemStatus): ItemStatus | null => {
  const i = FLOW.indexOf(status);
  return i >= 0 && i < FLOW.length - 1 ? FLOW[i + 1] : null;
};

export function IssueScreen({ projectId, itemId }: { projectId: string; itemId: string }) {
  const { t, tx } = useI18n();
  const items = useItems(projectId);
  const boards = useBoards(projectId);
  const labels = useLabels(projectId);
  const history = useHistory(items.data?.find((i) => i.id === itemId || i.key === itemId)?.id);
  const { write } = useIssueWriter(projectId);
  const undo = useUndo(projectId);
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [aiOpen, setAiOpen] = usePanelOpen(aiOpenKey);

  const item = items.data?.find((i) => i.id === itemId || i.key === itemId);
  if (!item) {
    return (
      <div className="app">
        <header className="titlebar">
          <Link to="/" className="btn btn-ghost no-drag" style={{ padding: "4px 8px" }}>
            <Icon name="i-back" size={14} /> {t("issueScreen.backProjects")}
          </Link>
        </header>
        <main className="sheet">
          <div className="issue-wrap">
            <p className="meta-txt">{items.isLoading ? t("issueScreen.loading") : t("issueScreen.notInProject")}</p>
          </div>
        </main>
        <StatusBar projectId={projectId} />
      </div>
    );
  }

  const board = boards.data?.find((b) => b.id === item.boardId);
  const epics = (items.data ?? []).filter((i) => i.kind === "epic");
  const blocks = item.blocks.map((id) => items.data?.find((i) => i.id === id)).filter((i): i is Item => !!i);
  const prov = provenanceOf(item);
  const next = nextStatus(item.status);

  const advance = () => {
    if (next) write(item, { status: next }, tx("fields.movedToStatusToast", { key: <span className="num">{item.key}</span>, status: STATUS[next].label }));
  };

  return (
    <div className="app">
      <header className="titlebar">
        <button type="button" className="btn btn-ghost no-drag" style={{ padding: "4px 8px" }} onClick={() => void navigate({ to: "/p/$projectId", params: { projectId } })}>
          <Icon name="i-back" size={14} /> <span>{board?.name ?? t("detailPane.fieldBoard")}</span>
        </button>
        <span className="crumb-sep">/</span>
        <span className="crumb-title num">{item.key}</span>
        <Spacer />
        <LockButton item={item} write={write} className="btn-ghost no-drag" />
        <button
          type="button"
          className="btn btn-icon is-danger purge-btn no-drag"
          title={t("deleteIssueDialog.dialogLabelWithKey", { key: item.key })}
          aria-label={t("deleteIssueDialog.dialogLabelWithKey", { key: item.key })}
          onClick={() => setDeleting(true)}
        >
          <Icon name="i-trash" size={15} />
        </button>
        {next && (
          <button type="button" className="btn btn-primary no-drag" onClick={advance}>
            {t("issueScreen.moveToButton", { status: STATUS[next].label })}
          </button>
        )}
        <button type="button" className="btn btn-icon no-drag" title={t("settingsDialog.dialogLabel")} aria-label={t("settingsDialog.dialogLabel")} onClick={() => setSettingsOpen(true)}>
          <Icon name="i-gear" size={17} />
        </button>
      </header>

      <div className="workspace">
        <main className="sheet">
          <div className="issue-wrap">
            {/* Epic and labels used to be read-only chips here; they are fields
                now, so the row carries identity only and there is one truth. */}
            <div className="row" style={{ gap: 7 }}>
              <span className="card-id">{item.key}</span>
            </div>
            <IssueTitle item={item} write={write} heading="h1" />

            <div className="fieldstrip">
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldStatus")}</span>
                <span className="fs-v">
                  <StatusField item={item} write={write} />
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldPriority")}</span>
                <span className="fs-v">
                  <PriorityField item={item} write={write} />
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldEpic")}</span>
                <span className="fs-v">
                  <EpicField item={item} write={write} epics={epics} />
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldLabelsCol")}</span>
                <span className="fs-v">
                  <LabelsField item={item} write={write} vocabulary={labels.data ?? []} />
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldBoard")}</span>
                <span className="fs-v">
                  <BoardField item={item} write={write} boards={boards.data ?? []} />
                </span>
              </span>
              {/* Kind is structure: an epic names a column, so it is not a field
                  you flip in passing. */}
              <span className="fs-item">
                <span className="fs-k">{t("issueScreen.fieldKind")}</span>
                <span className="fs-v">{item.kind === "epic" ? t("detailPane.fieldEpic") : t("issueScreen.kindTicket")}</span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldVersion")}</span>
                <span className="fs-v num">{item.version}</span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldLastWrite")}</span>
                <span className="fs-v">
                  {prov === "ai" && <span className="prov-tick" style={{ height: 12 }} />}
                  {prov === "locked" && <Icon className="prov-lock" name="i-lock" size={13} />}
                  {PROVENANCE[prov]} · {agoLabel(item.updatedAt)}
                </span>
              </span>
            </div>

            {item.humanLocked && (
              <div className="lockbar">
                <Icon name="i-lock" size={15} style={{ color: "var(--meta)", flexShrink: 0, marginTop: 2 }} />
                <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
                  {tx("detailPane.lockedNotice", { strong: <strong>{t("detailPane.lockedNoticeStrong")}</strong> })}
                </p>
              </div>
            )}

            <div className="body-prose">
              <IssueBody item={item} write={write} className="bp-body" />
              {blocks.length > 0 && (
                <>
                  <h3>{t("detailPane.blocksHeading")}</h3>
                  <div style={{ marginTop: "var(--space-2)" }}>
                    {blocks.map((b) => (
                      <button
                        key={b.id}
                        type="button"
                        className="rel-row"
                        onClick={() => void navigate({ to: "/p/$projectId/i/$itemId", params: { projectId, itemId: b.id } })}
                      >
                        <StatusMark status={b.status} size={13} />
                        <span className="r-t">{b.title}</span>
                        <span className="card-id">{b.key}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <PluginSections itemId={item.id} variant="sheet" />

            <hr className="rule" />
            <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{t("detailPane.activityHeading")}</Eyebrow>
            <div className="ledger">
              {(history.data ?? []).map((entry) => (
                <LedgerRow key={entry.seq} entry={entry} />
              ))}
            </div>
            <p className="meta-txt dense" style={{ marginTop: "var(--space-4)" }}>
              {tx("detailPane.ledgerFooter", { cmdz: <span className="num">⌘Z</span> })}
            </p>
          </div>
        </main>

        <AgentPanel open={aiOpen} onToggle={setAiOpen} projectId={projectId} onOpenSettings={() => setSettingsOpen(true)} />
      </div>

      <StatusBar projectId={projectId} onUndo={() => undo.mutate(undefined)}>
        <ThemeSwitch compact />
      </StatusBar>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <DeleteIssueDialog
        item={deleting ? item : null}
        items={items.data ?? []}
        projectId={projectId}
        onOpenChange={setDeleting}
        // this route is the issue; destroying it would otherwise leave the
        // "not in this project" fallback as the terminal state of a delete
        onDeleted={() => void navigate({ to: "/p/$projectId", params: { projectId }, replace: true })}
      />
    </div>
  );
}
