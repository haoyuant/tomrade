import * as RadixDialog from "@radix-ui/react-dialog";
import type { Item, OplogEntry } from "@tomradex/domain";
import { ICON_IDS, Icon, type IconId } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import {
  BoardField,
  CustomField,
  DerivedField,
  DepsField,
  EpicField,
  IssueTitle,
  LabelsField,
  LockButton,
  PriorityField,
  StatusField,
  WorkTypeField,
  useIssueWriter,
  type IssueWrite
} from "~/components/issue/fields";
import { IssueBody } from "~/components/onDemand";
import { StartTicket } from "~/components/issue/StartTicket";
import { DeliveryPanel } from "~/components/issue/DeliveryPanel";
import { PROVENANCE, agoLabel, authorLabel, describeWrite, fieldLabel, ledgerMarkOf, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useFields, useHistory, useRunCommand, useSections } from "~/lib/queries";
import { requestStart } from "~/lib/codeLink";
import { askPanel } from "~/lib/panelRequests";
import { openExternal } from "~/lib/shell";
import { TicketSessions } from "~/components/issue/TicketSessions";
import { TicketSpend } from "~/components/issue/TicketSpend";
import { errorSpec, useToast } from "~/lib/toast";
import { useWorkspace } from "./context";
import { useOptionalAgentDock } from "~/components/chrome/ProjectShell";
import { keyLabel } from "~/lib/keybindings";
import { isComposing } from "~/lib/keys";

/** Title and body are the only fields a lock covers; status stays agent-writable. */
function LockBar() {
  const { t, tx } = useI18n();
  return (
    <div className="lockbar">
      <Icon name="i-lock" size={15} style={{ color: "var(--meta)", flexShrink: 0, marginTop: 2 }} />
      <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
        {tx("detailPane.lockedNotice", { strong: <strong>{t("detailPane.lockedNoticeStrong")}</strong> })}
      </p>
    </div>
  );
}

/** Derived from the oplog itself, so it can never drift from the data it describes. */
function Ledger({ projectId, itemId }: { projectId: string; itemId: string }) {
  const { t, tx } = useI18n();
  const history = useHistory(projectId, itemId);
  const rows = history.data ?? [];
  return (
    <section className="detail-sect">
      <Eyebrow>{t("detailPane.activityHeading")}</Eyebrow>
      <div className="ledger">
        {rows.map((entry) => (
          <LedgerRow key={entry.seq} entry={entry} />
        ))}
        {rows.length === 0 && <p className="meta-txt">{t("detailPane.noWritesYet")}</p>}
      </div>
      <p className="meta-txt detail-note">{tx("detailPane.ledgerFooter", { cmdz: <span className="num">{keyLabel("undo")}</span> })}</p>
    </section>
  );
}

/** Plugin sections come as rows and text; the pane draws them with its own primitives. A row may open a link or run a command. */
export function PluginSections({ projectId, itemId, variant = "pane" }: { projectId: string; itemId: string; variant?: "pane" | "sheet" }) {
  const sections = useSections(projectId, itemId);
  const runCommand = useRunCommand(projectId);
  const toast = useToast();
  const dock = useOptionalAgentDock();
  const run = (id: string) =>
    runCommand.mutate({ id, scope: { projectId, itemId } }, { onSuccess: (r) => {
        // a start that stopped opens the ticket's Start dialog, where its fix is
        if (r.startDialog && requestStart(itemId, r.startDialog)) return;
        if (r.toast) toast({ body: r.toast });
        if (r.showThread) dock?.showThread(r.showThread);
        // the ticket's ended session, looked back on in the panel with only this ticket's stretches open
        if (r.review) { dock?.setAiOpen(true); askPanel({ kind: "review", sessionId: r.review.sessionId, itemId: r.review.itemId ?? itemId }); }
      }, onError: (e) => toast(errorSpec(e)) });
  return (
    <>
      {(sections.data ?? []).map((s) => {
        const body = (
          <>
            {s.rows.length > 0 && (
              <dl className="fieldstrip" style={{ marginTop: 0 }}>
                {s.rows.map((r, i) => {
                  const icon = r.icon && (ICON_IDS as readonly string[]).includes(r.icon) ? (r.icon as IconId) : null;
                  const value = r.href ? (
                    <a
                      href={r.href}
                      onClick={(e) => {
                        e.preventDefault();
                        openExternal(r.href!);
                      }}
                    >
                      {r.value}
                    </a>
                  ) : r.command ? (
                    <button type="button" className="btn btn-secondary" disabled={runCommand.isPending} onClick={() => run(r.command!)}>
                      {r.value}
                    </button>
                  ) : (
                    <span className={r.mono ? "num sect-value" : "sect-value"}>{r.value}</span>
                  );
                  return (
                    <div className={r.state === "live" ? "field-row sect-row is-live" : "field-row sect-row"} key={`${r.label}-${i}`}>
                      <dt className={icon ? "sect-dt" : undefined}>
                        {icon && <Icon name={icon} size={12} aria-hidden="true" />}
                        {r.label}
                      </dt>
                      <dd>
                        {r.state && <span className={`state-mark is-${r.state}`} aria-hidden="true" />}
                        {value}
                        {r.state === "live" && <span className="sect-runner" aria-hidden="true" />}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            )}
            {s.text && <p className="meta-txt detail-note">{s.text}</p>}
          </>
        );
        return variant === "pane" ? (
          <section className="detail-sect" key={s.id}>
            <Eyebrow>{s.title}</Eyebrow>
            {body}
          </section>
        ) : (
          <div key={s.id}>
            <hr className="rule" />
            <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{s.title}</Eyebrow>
            {body}
          </div>
        );
      })}
    </>
  );
}

/** Shared by the docked pane and the standalone issue sheet. */
export function LedgerRow({ entry }: { entry: OplogEntry }) {
  const { t } = useI18n();
  const after = (entry.after ?? entry.before) as Item | null;
  const mark = ledgerMarkOf(entry);
  return (
    <div className="ledger-row">
      <span className="ledger-mark">
        {mark === "lock" && <Icon className="prov-lock" name="i-lock" size={12} />}
        {mark === "tick" && <span className="prov-tick" style={{ height: 11 }} />}
        {mark === "sync" && <Icon name="i-sync" size={11} style={{ color: "var(--meta)" }} />}
      </span>
      <span className="ledger-txt">
        <b>{authorLabel(entry.by)}</b> {describeWrite(entry)}
        {after && entry.op !== "merge" && entry.op !== "rank" ? (
          <>
            {" "}
            · {t("detailPane.versionWord")} <span className="num">{after.version}</span>
          </>
        ) : null}{" "}
        · {agoLabel(entry.at)}
      </span>
    </div>
  );
}

function FieldStrip({ item, write }: { item: Item; write: IssueWrite }) {
  const { t } = useI18n();
  const { project, epics, boards, labels, items, select } = useWorkspace();
  const fields = useFields(project.id);
  const custom = (fields.data ?? []).filter((f) => !f.builtin);
  // a computed value only once there is one: a ticket nobody ran has spent nothing worth a row
  const derived = (fields.data ?? []).filter((f) => f.derived && typeof item.fields[f.id] === "number");
  const prov = provenanceOf(item);
  return (
    <dl className="fieldstrip">
      <div className="field-row">
        <dt>{t("fields.workType")}</dt>
        <dd><WorkTypeField item={item} write={write} /></dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldStatus")}</dt>
        <dd>
          <StatusField item={item} write={write} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldPriority")}</dt>
        <dd>
          <PriorityField item={item} write={write} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldEpic")}</dt>
        <dd>
          <EpicField item={item} write={write} epics={epics} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldLabelsCol")}</dt>
        <dd>
          <LabelsField item={item} write={write} vocabulary={labels} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldBlockedBy")}</dt>
        <dd>
          <DepsField item={item} write={write} items={items} mode="blockedBy" onOpen={select} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldBlocks")}</dt>
        <dd>
          <DepsField item={item} write={write} items={items} mode="blocks" onOpen={select} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldBoard")}</dt>
        <dd>
          <BoardField item={item} write={write} boards={boards} />
        </dd>
      </div>
      {/* custom fields follow the built-ins, in the order the project ranks them */}
      {custom.map((def) => (
        <div className="field-row" key={def.id} data-field={def.id}>
          <dt>{fieldLabel(def)}</dt>
          <dd>
            <CustomField item={item} write={write} def={def} />
          </dd>
        </div>
      ))}
      {derived.map((def) => (
        <div className="field-row" key={def.id} data-field={def.id}>
          <dt>{fieldLabel(def)}</dt>
          <dd>
            <DerivedField item={item} def={def} />
          </dd>
        </div>
      ))}
      <div className="field-row">
        <dt>{t("detailPane.fieldLastWrite")}</dt>
        <dd>
          {prov === "ai" && <span className="prov-tick" style={{ height: 12 }} />}
          {prov === "locked" && <Icon className="prov-lock" name="i-lock" size={13} />}
          {PROVENANCE[prov]} · {agoLabel(item.updatedAt)}
        </dd>
      </div>
    </dl>
  );
}

export function DetailPane({
  item,
  expanded,
  onToggleExpand,
  onClose,
  onDelete,
  onOpenRepositories
}: {
  item: Item;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  /** Opens the confirmation. The pane never destroys anything itself. */
  onDelete: () => void;
  /** Where Start sends the user when the workstream has no repository, or this machine no checkout of it. */
  onOpenRepositories?: () => void;
}) {
  const body = <DetailBody item={item} expanded={expanded} onToggleExpand={onToggleExpand} onClose={onClose} onDelete={onDelete} onOpenRepositories={onOpenRepositories} />;

  // Expanded, the pane reads as a modal overlay, so it is one: Radix supplies
  // the focus trap, the focus restore and the Escape that collapses it.
  if (expanded) {
    return (
      <RadixDialog.Root open onOpenChange={(open) => !open && onToggleExpand()}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="scrim" />
          <RadixDialog.Content
            className="detail expanded"
            aria-label={`${item.key} — ${item.title}`}
            // the body editor takes Escape as "discard my edit", not "close the overlay";
            // an IME takes it to dismiss its candidate list
            onEscapeKeyDown={(e) => {
              if (isComposing(e) || (e.target as Element | null)?.closest?.(".body-editor")) e.preventDefault();
            }}
          >
            <RadixDialog.Title className="sr-only">{item.title}</RadixDialog.Title>
            {body}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    );
  }
  // focusable as a whole, so a card opened from the keyboard can hand focus over
  return (
    <aside className="detail" tabIndex={-1} aria-label={`${item.key} — ${item.title}`}>
      {body}
    </aside>
  );
}

function DetailBody({
  item,
  expanded,
  onToggleExpand,
  onClose,
  onDelete,
  onOpenRepositories
}: {
  item: Item;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onDelete: () => void;
  onOpenRepositories?: () => void;
}) {
  const { t } = useI18n();
  const { project, boards, items, select } = useWorkspace();
  const { write } = useIssueWriter(project.id);
  const owner = boards.find((b) => b.id === item.boardId);
  // A gate may name another ticket (the bootstrap one) by key; the pane shows it in place.
  const openIssue = (idOrKey: string) => {
    const target = items.find((i) => i.id === idOrKey || i.key === idOrKey);
    if (target) select(target.id);
  };

  return (
    <>
      <div className="detail-head">
        <span className="card-id" style={{ whiteSpace: "nowrap" }}>{item.key}</span>
        {owner && <span className="tag neutral">{owner.name}</span>}
        <Spacer />
        <StartTicket projectId={project.id} item={item} onOpenIssue={openIssue} onOpenRepositories={onOpenRepositories} />
        <LockButton item={item} write={write} />
        {/* Sits away from Close, and carries its own class rather than another
            bare `.btn-icon` — the head is addressed by position in places. */}
        <button
          type="button"
          className="btn btn-icon is-danger purge-btn"
          title={t("deleteIssueDialog.dialogLabelWithKey", { key: item.key })}
          aria-label={t("deleteIssueDialog.dialogLabelWithKey", { key: item.key })}
          onClick={onDelete}
        >
          <Icon name="i-trash" size={15} />
        </button>
        <button
          type="button"
          className="btn btn-icon"
          title={expanded ? t("detailPane.collapseTitle") : t("detailPane.expandTitle")}
          aria-label={expanded ? t("detailPane.collapseDetailAria") : t("detailPane.expandDetailAria")}
          onClick={onToggleExpand}
        >
          <Icon name={expanded ? "i-shrink" : "i-expand"} size={15} />
        </button>
        <button type="button" className="btn btn-icon" aria-label={t("detailPane.closeDetailAria")} onClick={onClose}>
          <Icon name="i-close" size={15} />
        </button>
      </div>
      <div className="detail-body">
        <IssueTitle item={item} write={write} heading="h2" />
        <FieldStrip item={item} write={write} />
        <div className="detail-cols">
          <div className="detail-main">
            {item.humanLocked && <LockBar />}
            <IssueBody key={`body:${item.id}`} item={item} write={write} className="issue-body" />
            <DeliveryPanel key={item.id} item={item} />
            <PluginSections projectId={item.projectId} itemId={item.id} />
            {item.kind === "ticket" && <TicketSessions projectId={item.projectId} itemId={item.id} />}
            {item.kind === "ticket" && <TicketSpend projectId={item.projectId} itemId={item.id} />}
          </div>
          <aside className="detail-side">
            <Ledger projectId={item.projectId} itemId={item.id} />
          </aside>
        </div>
      </div>
    </>
  );
}
