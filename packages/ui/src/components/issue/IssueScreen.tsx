import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Item, ItemStatus } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { DeleteIssueDialog } from "~/components/dialogs/DeleteIssueDialog";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { useScreenBinding, type ScreenBinding } from "~/components/chrome/ProjectShell";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { IssueBody } from "~/components/issue/IssueBody";
import { StartTicket } from "~/components/issue/StartTicket";
import { DeliveryPanel } from "~/components/issue/DeliveryPanel";
import { LedgerRow, PluginSections } from "~/components/workspace/DetailPane";
import {
  BoardField,
  CustomField,
  DepsField,
  EpicField,
  IssueTitle,
  LabelsField,
  LockButton,
  PriorityField,
  StatusField,
  WorkTypeField,
  useIssueWriter
} from "~/components/issue/fields";
import { PROVENANCE, STATUS, agoLabel, fieldLabel, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useBoards, useFields, useHistory, useItems, useLabels, useUndo } from "~/lib/queries";
import { shortcut } from "~/lib/keys";

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
  const fields = useFields(projectId);
  const history = useHistory(projectId, items.data?.find((i) => i.id === itemId || i.key === itemId)?.id);
  const { write } = useIssueWriter(projectId);
  const undo = useUndo(projectId);
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Where the panel sent Settings: the assistant pane, maybe at one engine's row. */
  const [settingsAt, setSettingsAt] = useState<{ pane: string; engine?: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  const item = items.data?.find((i) => i.id === itemId || i.key === itemId);

  const openIssue = useCallback((id: string) => void navigate({ to: "/p/$projectId/i/$itemId", params: { projectId, itemId: id } }), [navigate, projectId]);
  const binding = useMemo<ScreenBinding>(
    () => ({
      openIssue,
      openSettings: (engineId) => {
        setSettingsAt({ pane: "assistant", engine: engineId });
        setSettingsOpen(true);
      },
      focus: item ? [{ kind: "item", id: item.id, key: item.key, title: item.title }] : []
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openIssue, item?.id, item?.key, item?.title]
  );
  useScreenBinding(binding);

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
  const prov = provenanceOf(item);
  const next = nextStatus(item.status);

  const advance = () => {
    if (next) write(item, { status: next }, tx("fields.movedToStatusToast", { key: <span className="num">{item.key}</span>, status: STATUS[next].label }));
  };

  const startable = item.kind === "ticket" && item.status !== "done" && item.status !== "cancelled";

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
        <StartTicket projectId={projectId} item={item} onOpenIssue={openIssue} onOpenRepositories={() => setSettingsOpen(true)} className="no-drag" />
        {next && !startable && (
          <button type="button" className="btn btn-primary no-drag" onClick={advance}>
            {t("issueScreen.moveToButton", { status: STATUS[next].label })}
          </button>
        )}
        {next && startable && (
          <button type="button" className="btn btn-secondary no-drag" onClick={advance}>
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
                <span className="fs-k">{t("fields.workType")}</span>
                <span className="fs-v"><WorkTypeField item={item} write={write} /></span>
              </span>
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
                <span className="fs-k">{t("detailPane.fieldBlockedBy")}</span>
                <span className="fs-v">
                  <DepsField item={item} write={write} items={items.data ?? []} mode="blockedBy" onOpen={openIssue} />
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldBlocks")}</span>
                <span className="fs-v">
                  <DepsField item={item} write={write} items={items.data ?? []} mode="blocks" onOpen={openIssue} />
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldBoard")}</span>
                <span className="fs-v">
                  <BoardField item={item} write={write} boards={boards.data ?? []} />
                </span>
              </span>
              {(fields.data ?? [])
                .filter((f) => !f.builtin)
                .map((def) => (
                  <span className="fs-item" key={def.id} data-field={def.id}>
                    <span className="fs-k">{fieldLabel(def)}</span>
                    <span className="fs-v">
                      <CustomField item={item} write={write} def={def} />
                    </span>
                  </span>
                ))}
              {/* Kind is structure: an epic names a column, so it is not a field
                  you flip in passing. */}
              <span className="fs-item">
                <span className="fs-k">{t("issueScreen.fieldKind")}</span>
                <span className="fs-v">{item.kind === "epic" ? t("detailPane.fieldEpic") : t("issueScreen.kindTicket")}</span>
              </span>
              <span className="fs-item">
                <span className="fs-k">{t("detailPane.fieldLastWrite")}</span>
                <span className="fs-v">
                  {(prov === "ai" || prov === "sync") && <span className={prov === "sync" ? "prov-tick is-sync" : "prov-tick"} style={{ height: 12 }} />}
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
              <IssueBody key={`body:${item.id}`} item={item} write={write} className="bp-body" />
              <DeliveryPanel key={item.id} item={item} />
            </div>

            <PluginSections projectId={projectId} itemId={item.id} variant="sheet" />

            <hr className="rule" />
            <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{t("detailPane.activityHeading")}</Eyebrow>
            <div className="ledger">
              {(history.data ?? []).map((entry) => (
                <LedgerRow key={entry.seq} entry={entry} />
              ))}
            </div>
            <p className="meta-txt dense" style={{ marginTop: "var(--space-4)" }}>
              {tx("detailPane.ledgerFooter", { cmdz: <span className="num">{shortcut("⌘Z")}</span> })}
            </p>
          </div>
        </main>
      </div>

      <StatusBar projectId={projectId} onUndo={() => undo.mutate(undefined)}>
        <ThemeSwitch compact />
      </StatusBar>
      <SettingsDialog
        open={settingsOpen}
        pane={settingsAt?.pane}
        engine={settingsAt?.engine}
        onOpenChange={(open) => {
          setSettingsOpen(open);
          if (!open) setSettingsAt(null);
        }}
      />
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
