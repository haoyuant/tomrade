import { useCallback, useMemo, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Item, ItemStatus } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { DeleteIssueDialog } from "~/components/dialogs/DeleteIssueDialog";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { useAgentDock, useScreenBinding, type ScreenBinding } from "~/components/chrome/ProjectShell";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { Menu, MenuActionItem, MenuHead } from "~/components/ui/menu";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { useCodeSessions, useStartTicket } from "~/lib/codeLink";
import { useToast } from "~/lib/toast";
import { LedgerRow, PluginSections } from "~/components/workspace/DetailPane";
import {
  BoardField,
  CustomField,
  DepsField,
  EpicField,
  IssueBody,
  IssueTitle,
  LabelsField,
  LockButton,
  PriorityField,
  StatusField,
  useIssueWriter
} from "~/components/issue/fields";
import { PROVENANCE, STATUS, agoLabel, fieldLabel, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useBoards, useFields, useHistory, useItems, useLabels, useUndo } from "~/lib/queries";

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
  const toast = useToast();
  const { showThread } = useAgentDock();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const item = items.data?.find((i) => i.id === itemId || i.key === itemId);
  const sessions = useCodeSessions(projectId, item?.id);
  const start = useStartTicket(projectId);

  const openIssue = useCallback((id: string) => void navigate({ to: "/p/$projectId/i/$itemId", params: { projectId, itemId: id } }), [navigate, projectId]);
  const binding = useMemo<ScreenBinding>(
    () => ({
      openIssue,
      openSettings: () => setSettingsOpen(true),
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

  // Start hands the ticket to a local coding agent; Continue picks its thread back up. Each gate answers with the one thing that clears it.
  const startable = item.kind === "ticket" && item.status !== "done" && item.status !== "cancelled";
  const hasSession = (sessions.data?.length ?? 0) > 0;
  const startTicket = (mode: "run" | "terminal") =>
    start.mutate(
      { itemId: item.id, mode },
      {
        onSuccess: (result) => {
          if (!result.ok) {
            const actions =
              result.gate === "readiness" && result.bootstrapKey
                ? [{ label: t("codeLink.gateOpenBootstrap", { key: result.bootstrapKey }), run: () => openIssue(result.bootstrapKey!) }]
                : result.gate === "checkout" || result.gate === "workstream"
                  ? [{ label: t("codeLink.gateRepositories"), run: () => setSettingsOpen(true) }]
                  : undefined;
            toast({ body: result.message, actions });
            return;
          }
          const vars = { key: item.key, branch: result.branch };
          if (result.mode === "run") {
            toast({ body: t(result.continued ? "codeLink.continuedToast" : "codeLink.startedToast", vars) });
            showThread(result.threadId);
          } else if (result.launched) {
            toast({ body: t("codeLink.terminalToast", vars) });
          } else {
            const command = result.command ?? "";
            toast({ body: command, actions: [{ label: t("codeLink.copyCommand"), run: () => void navigator.clipboard?.writeText(command).then(() => toast({ body: t("codeLink.commandCopied") })) }] });
          }
        },
        onError: (e) => toast({ body: e.message })
      }
    );

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
        {startable && (
          <Menu
            label={t(hasSession ? "codeLink.continue" : "codeLink.start")}
            align="end"
            trigger={
              <button type="button" className="btn btn-primary no-drag" data-testid="start-ticket" disabled={start.isPending}>
                {start.isPending ? t("codeLink.starting") : t(hasSession ? "codeLink.continue" : "codeLink.start")} <Icon name="i-chevdown" size={12} />
              </button>
            }
          >
            <MenuHead title={item.key} />
            <MenuActionItem icon={<Icon name="i-plug" size={14} />} name={t("codeLink.startHere")} onSelect={() => startTicket("run")} />
            <MenuActionItem icon={<Icon name="i-monitor" size={14} />} name={t("codeLink.startTerminal")} onSelect={() => startTicket("terminal")} />
          </Menu>
        )}
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
              {tx("detailPane.ledgerFooter", { cmdz: <span className="num">⌘Z</span> })}
            </p>
          </div>
        </main>
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
