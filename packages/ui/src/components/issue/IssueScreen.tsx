import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import type { Item, ItemStatus } from "@tomrade/core";
import { Icon } from "~/components/icons";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { AiPanel, aiOpenDefault } from "~/components/workspace/AiPanel";
import { Eyebrow, PriorityGlyph, Spacer, StatusMark, Tag } from "~/components/ui/atoms";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { LedgerRow } from "~/components/workspace/DetailPane";
import { PRIORITY_LABEL, PROVENANCE, STATUS, agoLabel, provenanceOf } from "~/lib/domain";
import { useBoards, useHistory, useItems, usePatchItem, useUndo } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/** backlog → todo → doing → verifying → done. The header offers the next step. */
const FLOW: ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done"];
const nextStatus = (status: ItemStatus): ItemStatus | null => {
  const i = FLOW.indexOf(status);
  return i >= 0 && i < FLOW.length - 1 ? FLOW[i + 1] : null;
};

export function IssueScreen({ projectId, itemId }: { projectId: string; itemId: string }) {
  const items = useItems(projectId);
  const boards = useBoards(projectId);
  const history = useHistory(items.data?.find((i) => i.id === itemId || i.key === itemId)?.id);
  const patch = usePatchItem(projectId);
  const undo = useUndo(projectId);
  const toast = useToast();
  const navigate = useNavigate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(aiOpenDefault);

  const item = items.data?.find((i) => i.id === itemId || i.key === itemId);
  if (!item) {
    return (
      <div className="app">
        <header className="titlebar">
          <Link to="/" className="btn btn-ghost no-drag" style={{ padding: "4px 8px" }}>
            <Icon name="i-back" size={14} /> Projects
          </Link>
        </header>
        <main className="sheet">
          <div className="issue-wrap">
            <p className="meta-txt">{items.isLoading ? "Loading…" : "That issue is not in this project."}</p>
          </div>
        </main>
        <StatusBar />
      </div>
    );
  }

  const board = boards.data?.find((b) => b.id === item.boardId);
  const epic = item.parentId ? items.data?.find((i) => i.id === item.parentId) : undefined;
  const blocks = item.blocks.map((id) => items.data?.find((i) => i.id === id)).filter((i): i is Item => !!i);
  const prov = provenanceOf(item);
  const next = nextStatus(item.status);

  const advance = () => {
    if (!next) return;
    patch.mutate(
      { id: item.id, patch: { status: next }, baseVersion: item.version },
      {
        onSuccess: () => toast({ body: <>Moved <span className="num">{item.key}</span> to {STATUS[next].label}</>, onUndo: () => undo.mutate(item.id) }),
        // a refused write must say so; react-query swallows the rejection otherwise
        onError: (err) =>
          toast({
            body: /conflict/i.test(err.message)
              ? <>An agent wrote to <span className="num">{item.key}</span> first — it re-read, so try again.</>
              : err.message
          })
      }
    );
  };

  return (
    <div className="app">
      <header className="titlebar">
        <button type="button" className="btn btn-ghost no-drag" style={{ padding: "4px 8px" }} onClick={() => void navigate({ to: "/p/$projectId", params: { projectId } })}>
          <Icon name="i-back" size={14} /> <span>{board?.name ?? "Board"}</span>
        </button>
        <span className="crumb-sep">/</span>
        <span className="crumb-title num">{item.key}</span>
        <Spacer />
        {next && (
          <button type="button" className="btn btn-primary no-drag" onClick={advance}>
            Move to {STATUS[next].label}
          </button>
        )}
        <button type="button" className="btn btn-icon no-drag" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="i-gear" size={17} />
        </button>
      </header>

      <div className="workspace">
        <main className="sheet">
          <div className="issue-wrap">
            <div className="row" style={{ gap: 7 }}>
              <span className="card-id">{item.key}</span>
              {epic && <Tag>{epic.title}</Tag>}
              {item.labels.map((l) => (
                <Tag key={l} tone="faint">
                  {l}
                </Tag>
              ))}
            </div>
            <h1 className="issue-title">{item.title}</h1>

            <div className="fieldstrip">
              <span className="fs-item">
                <span className="fs-k">Status</span>
                <span className="fs-v">
                  <StatusMark status={item.status} size={13} /> {STATUS[item.status].label}
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">Priority</span>
                <span className="fs-v">
                  <PriorityGlyph priority={item.priority} size={13} always /> {PRIORITY_LABEL[item.priority]}
                </span>
              </span>
              <span className="fs-item">
                <span className="fs-k">Kind</span>
                <span className="fs-v">{item.kind === "epic" ? "Epic" : "Ticket · one PR"}</span>
              </span>
              <span className="fs-item">
                <span className="fs-k">Board</span>
                <span className="fs-v">{board?.name ?? "—"}</span>
              </span>
              <span className="fs-item">
                <span className="fs-k">Version</span>
                <span className="fs-v num">{item.version}</span>
              </span>
              <span className="fs-item">
                <span className="fs-k">Last write</span>
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
                  Title and body are <strong>human-locked</strong>. Agents can still read this issue and change its status, but a write to the locked
                  fields is rejected with a typed error rather than merged.
                </p>
              </div>
            )}

            <div className="body-prose">
              <p>{item.body ?? "No description yet."}</p>
              {blocks.length > 0 && (
                <>
                  <h3>Blocks</h3>
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

            <hr className="rule" />
            <Eyebrow style={{ marginBottom: "var(--space-3)" }}>Activity · append-only oplog</Eyebrow>
            <div className="ledger">
              {(history.data ?? []).map((entry) => (
                <LedgerRow key={entry.seq} entry={entry} />
              ))}
            </div>
            <p className="meta-txt dense" style={{ marginTop: "var(--space-4)" }}>
              Every row above is reversible. <span className="num">⌘Z</span> walks the oplog backwards, newest first.
            </p>
          </div>
        </main>

        <AiPanel
          open={aiOpen}
          onToggle={setAiOpen}
          scope={{ projectId, label: item.key, trace: `get_item · ${item.key}`, placeholder: `Ask about ${item.key}…` }}
        />
      </div>

      <StatusBar onUndo={() => undo.mutate(undefined)}>
        <ThemeSwitch compact />
      </StatusBar>
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
