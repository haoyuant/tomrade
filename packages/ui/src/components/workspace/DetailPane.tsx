import * as RadixDialog from "@radix-ui/react-dialog";
import type { Item, OplogEntry } from "@tomrade/core";
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
import { useHistory } from "~/lib/queries";
import { useWorkspace } from "./context";

/** Title and body are the only fields a lock covers; status stays agent-writable. */
function LockBar() {
  return (
    <div className="lockbar">
      <Icon name="i-lock" size={15} style={{ color: "var(--meta)", flexShrink: 0, marginTop: 2 }} />
      <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
        Title and body are <strong>human-locked</strong>. Agents can still read this issue and change its status, but a write to the locked fields is
        rejected with a typed error rather than merged.
      </p>
    </div>
  );
}

/** Derived from the oplog itself, so it can never drift from the data it describes. */
export function Ledger({ itemId }: { itemId: string }) {
  const history = useHistory(itemId);
  const rows = history.data ?? [];
  return (
    <section className="detail-sect">
      <Eyebrow>Activity · append-only oplog</Eyebrow>
      <div className="ledger">
        {rows.map((entry) => (
          <LedgerRow key={entry.seq} entry={entry} />
        ))}
        {rows.length === 0 && <p className="meta-txt">No writes recorded yet.</p>}
      </div>
      <p className="meta-txt detail-note">
        Every row above is reversible. <span className="num">⌘Z</span> walks the oplog backwards, newest first.
      </p>
    </section>
  );
}

/** Shared by the docked pane and the standalone issue sheet. */
export function LedgerRow({ entry }: { entry: OplogEntry }) {
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
        {after ? <> · version <span className="num">{after.version}</span></> : null} · {agoLabel(entry.at)}
      </span>
    </div>
  );
}

export function FieldStrip({ item, write }: { item: Item; write: IssueWrite }) {
  const { epics, boards, labels } = useWorkspace();
  const prov = provenanceOf(item);
  return (
    <dl className="fieldstrip">
      <div className="field-row">
        <dt>Status</dt>
        <dd>
          <StatusField item={item} write={write} />
        </dd>
      </div>
      <div className="field-row">
        <dt>Priority</dt>
        <dd>
          <PriorityField item={item} write={write} />
        </dd>
      </div>
      <div className="field-row">
        <dt>Epic</dt>
        <dd>
          <EpicField item={item} write={write} epics={epics} />
        </dd>
      </div>
      <div className="field-row">
        <dt>Labels</dt>
        <dd>
          <LabelsField item={item} write={write} vocabulary={labels} />
        </dd>
      </div>
      <div className="field-row">
        <dt>Board</dt>
        <dd>
          <BoardField item={item} write={write} boards={boards} />
        </dd>
      </div>
      <div className="field-row">
        <dt>Version</dt>
        <dd>
          <span className="num">{item.version}</span>
        </dd>
      </div>
      <div className="field-row">
        <dt>Last write</dt>
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
  onClose
}: {
  item: Item;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}) {
  const body = <DetailBody item={item} expanded={expanded} onToggleExpand={onToggleExpand} onClose={onClose} />;

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
  onClose
}: {
  item: Item;
  expanded: boolean;
  onToggleExpand: () => void;
  onClose: () => void;
}) {
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
        <button type="button" className="btn btn-icon" title={expanded ? "Collapse" : "Expand"} aria-label={expanded ? "Collapse detail" : "Expand detail"} onClick={onToggleExpand}>
          <Icon name={expanded ? "i-shrink" : "i-expand"} size={15} />
        </button>
        <button type="button" className="btn btn-icon" aria-label="Close detail" onClick={onClose}>
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
                <Eyebrow>Blocks</Eyebrow>
                {blocks.map((b) => (
                  <button key={b.id} type="button" className="rel-row" onClick={() => select(b.id)}>
                    <StatusMark status={b.status} size={13} />
                    <span className="r-t">{b.title}</span>
                    <span className="card-id">{b.key}</span>
                  </button>
                ))}
              </section>
            )}
          </div>
          <aside className="detail-side">
            <Ledger itemId={item.id} />
          </aside>
        </div>
      </div>
    </>
  );
}
