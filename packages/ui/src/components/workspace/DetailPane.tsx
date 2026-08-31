import * as RadixDialog from "@radix-ui/react-dialog";
import type { Item, OplogEntry } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer, StatusMark } from "~/components/ui/atoms";
import {
  BoardField,
  EpicField,
  IssueBody,
  IssueTitle,
  LabelsField,
  LockButton,
  PriorityField,
  StatusField,
  useIssueWriter,
  type IssueWrite
} from "~/components/issue/fields";
import { PROVENANCE, agoLabel, describeWrite, ledgerMarkOf, provenanceOf } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useHistory, useSections } from "~/lib/queries";
import { useWorkspace } from "./context";

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
export function Ledger({ itemId }: { itemId: string }) {
  const { t, tx } = useI18n();
  const history = useHistory(itemId);
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
      <p className="meta-txt detail-note">{tx("detailPane.ledgerFooter", { cmdz: <span className="num">⌘Z</span> })}</p>
    </section>
  );
}

/** Plugin sections come as rows and text; the pane draws them with its own primitives. */
export function PluginSections({ itemId, variant = "pane" }: { itemId: string; variant?: "pane" | "sheet" }) {
  const sections = useSections(itemId);
  return (
    <>
      {(sections.data ?? []).map((s) => {
        const body = (
          <>
            {s.rows.length > 0 && (
              <dl className="fieldstrip" style={{ marginTop: 0 }}>
                {s.rows.map((r) => (
                  <div className="field-row" key={r.label}>
                    <dt>{r.label}</dt>
                    <dd>{r.value}</dd>
                  </div>
                ))}
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
      </span>
      <span className="ledger-txt">
        <b>{entry.by}</b> {describeWrite(entry)}
        {after ? (
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

export function FieldStrip({ item, write }: { item: Item; write: IssueWrite }) {
  const { t } = useI18n();
  const { epics, boards, labels } = useWorkspace();
  const prov = provenanceOf(item);
  return (
    <dl className="fieldstrip">
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
        <dt>{t("detailPane.fieldBoard")}</dt>
        <dd>
          <BoardField item={item} write={write} boards={boards} />
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldVersion")}</dt>
        <dd>
          <span className="num">{item.version}</span>
        </dd>
      </div>
      <div className="field-row">
        <dt>{t("detailPane.fieldLastWrite")}</dt>
        <dd>
          {prov === "ai" && <span className="prov-tick" style={{ height: 12 }} />}
          {prov === "locked" && <Icon className="prov-lock" name="i-lock" size={13} />}
          <span className="num">{PROVENANCE[prov]}</span> · {agoLabel(item.updatedAt)}
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
  onDelete
}: {
  item: Item;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  /** Opens the confirmation. The pane never destroys anything itself. */
  onDelete: () => void;
}) {
  const body = <DetailBody item={item} expanded={expanded} onToggleExpand={onToggleExpand} onClose={onClose} onDelete={onDelete} />;

  // Expanded, the pane reads as a modal overlay, so it is one: Radix supplies
  // the focus trap, the focus restore and the Escape that collapses it.
  if (expanded) {
    return (
      <RadixDialog.Root open onOpenChange={(open) => !open && onToggleExpand()}>
        <RadixDialog.Portal>
          <RadixDialog.Overlay className="scrim" />
          <RadixDialog.Content className="detail expanded" aria-label={`${item.key} — ${item.title}`}>
            <RadixDialog.Title className="sr-only">{item.title}</RadixDialog.Title>
            {body}
          </RadixDialog.Content>
        </RadixDialog.Portal>
      </RadixDialog.Root>
    );
  }
  return <aside className="detail">{body}</aside>;
}

function DetailBody({
  item,
  expanded,
  onToggleExpand,
  onClose,
  onDelete
}: {
  item: Item;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const { project, boards, items, select } = useWorkspace();
  const { write } = useIssueWriter(project.id);
  const owner = boards.find((b) => b.id === item.boardId);
  const blocks = item.blocks.map((id) => items.find((i) => i.id === id)).filter((i): i is Item => !!i);

  return (
    <>
      <div className="detail-head">
        <span className="card-id">{item.key}</span>
        {owner && <span className="tag neutral">{owner.name}</span>}
        <Spacer />
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
            <IssueBody item={item} write={write} className="issue-body" />
            {blocks.length > 0 && (
              <section className="detail-sect">
                <Eyebrow>{t("detailPane.blocksHeading")}</Eyebrow>
                {blocks.map((b) => (
                  <button key={b.id} type="button" className="rel-row" onClick={() => select(b.id)}>
                    <StatusMark status={b.status} size={13} />
                    <span className="r-t">{b.title}</span>
                    <span className="card-id">{b.key}</span>
                  </button>
                ))}
              </section>
            )}
            <PluginSections itemId={item.id} />
          </div>
          <aside className="detail-side">
            <Ledger itemId={item.id} />
          </aside>
        </div>
      </div>
    </>
  );
}
