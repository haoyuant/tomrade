import { AgentConnection } from "../projects/AgentConnection";
import { useEffect, useRef, useState } from "react";
import { isMachinePath, repoPathLabel, repoSubfolder, type Board, type Item } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { useChooseRepoFolder } from "~/components/projects/RepositoriesBlock";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { IconPicker } from "~/components/ui/icon-picker";
import { Eyebrow, Tag } from "~/components/ui/atoms";
import { viewIcon } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { normalizeRemote } from "~/lib/remotes";
import {
  useBoards,
  useCreateBoard,
  useAllItems,
  useMoveItemsToBoard,
  useRemoveBoard,
  useRepoCheckouts,
  useRepos,
  useUpdateBoard
} from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";
import { useToastUndo } from "~/lib/undo";
import { keyLabel } from "~/lib/keybindings";
import { InlineEdit } from "~/components/ui/InlineEdit";
import { isCommitKey } from "~/lib/keys";

/**
 * One workstream as a small card: the head names it, the code line picks the
 * repository and folder its coding agents start in, and one sentence spells
 * out what that means on this machine.
 */
/**
 * Removing a workstream asks first, whatever it holds: it says where its
 * tickets go, that its repository binding goes with it, and that ⌘Z brings
 * it back. Cancel holds the focus.
 */
function RemoveWorkstreamDialog({
  open,
  onOpenChange,
  board,
  count,
  repoName,
  others,
  dest,
  onDest,
  pending,
  onConfirm
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  board: Board;
  count: number;
  repoName: string | null;
  others: Board[];
  dest: string;
  onDest: (id: string) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const { t, tx } = useI18n();
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("fieldsDialog.removeWorkstreamDialog", { name: board.name })} className="sheet-md">
      <DialogHead title={t("fieldsDialog.removeWorkstreamHead")} aside={<Tag tone="neutral">{board.name}</Tag>} />
      <DialogBody className="stack-3 ws-remove">
        {count > 0 ? (
          <div className="stack-2">
            <p className="meta-txt dense">{t(count === 1 ? "fieldsDialog.removeHoldsOne" : "fieldsDialog.removeHoldsMany", { n: count })}</p>
            <select className="select ws-remove-dest" aria-label={t("fieldsDialog.destinationAria")} value={dest} onChange={(e) => onDest(e.target.value)}>
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <p className="meta-txt dense">{t("fieldsDialog.removeEmpty")}</p>
        )}
        {repoName && <p className="meta-txt dense">{tx("fieldsDialog.removeRepo", { repo: <b>{repoName}</b> })}</p>}
        <p className="meta-txt dense">{tx("fieldsDialog.removeUndo", { cmdz: <span className="num">{keyLabel("undo")}</span> })}</p>
      </DialogBody>
      <DialogFoot>
        {/* Cancel takes the focus: Enter must not remove */}
        <button type="button" autoFocus className="btn btn-secondary" onClick={() => onOpenChange(false)}>
          {t("common.cancel")}
        </button>
        <button type="button" className="btn btn-danger ws-remove-confirm" disabled={pending || (count > 0 && !dest)} onClick={onConfirm}>
          <Icon name="i-trash" size={13} />
          {t(count > 0 ? "fieldsDialog.moveAndRemove" : "fieldsDialog.removeConfirm")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

/** The repository select's last option: pick a folder, add its repository, and point the workstream at it. */
const FROM_FOLDER = "__folder__";

function WorkstreamRow({ board, count, others, projectId, onOpenRepositories }: { board: Board; count: number; others: Board[]; projectId: string; onOpenRepositories?: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const update = useUpdateBoard(projectId);
  const repos = useRepos(projectId);
  const checkouts = useRepoCheckouts();
  const folder = useChooseRepoFolder(projectId);
  const remove = useRemoveBoard(projectId);
  const move = useMoveItemsToBoard(projectId);
  // Moving a workstream's tickets moves the old done ones too.
  const items = useAllItems(projectId);
  const undoWrite = useToastUndo(projectId);
  const [removing, setRemoving] = useState(false);
  const [dest, setDest] = useState(others[0]?.id ?? "");
  const fail = (err: Error) => toast(errorSpec(err));

  const repo = (repos.data ?? []).find((r) => r.id === board.repoId) ?? null;
  const checkout = repo ? ((checkouts.data ?? []).find((c) => c.remote === normalizeRemote(repo.remote))?.checkout ?? null) : null;
  const subdir = repoPathLabel(board.repoPath, checkout);
  const repoSelectId = `wsRepo-${board.id}`;
  const pathId = `wsPath-${board.id}`;

  const removeNow = () =>
    remove.mutate(board.id, {
      onSuccess: () => {
        setRemoving(false);
        toast({ body: tx("fieldsDialog.removedWorkstreamToast", { name: <b>{board.name}</b> }), onUndo: () => undoWrite({ id: board.id }) });
      },
      onError: fail
    });

  const moveThenRemove = () => {
    const target = others.find((b) => b.id === dest);
    if (!target || !items.data) return;
    const ids = items.data.filter((i) => i.boardId === board.id).map((i) => i.id);
    move.mutate(
      { from: board.id, to: target.id, itemIds: ids },
      {
        onSuccess: (n) => {
          toast({ body: tx("fieldsDialog.movedWorkstreamToast", { n: <span className="num">{n}</span>, name: <b>{target.name}</b> }) });
          removeNow();
        },
        onError: fail
      }
    );
  };

  const repositoriesLink = onOpenRepositories && (
    <button type="button" className="link-btn" onClick={onOpenRepositories}>
      {t("fieldsDialog.openRepositories")}
    </button>
  );

  return (
    <div className="fld-ws" data-board={board.id}>
      <div className="fld-ws-head">
        <IconPicker compact value={viewIcon(board.icon)} ariaLabel={t("fieldsDialog.workstreamIconAria")} onChange={(icon) => update.mutate({ id: board.id, patch: { icon } }, { onError: fail })} />
        <InlineEdit value={board.name} aria-label={t("fieldsDialog.workstreamNameAria")} className="input fld-ws-name" onSave={(name) => update.mutate({ id: board.id, patch: { name } }, { onError: fail })} />
        <span className="meta-txt num">{t(count === 1 ? "fieldsDialog.valuesOne" : "fieldsDialog.valuesMany", { n: count })}</span>
        <button
          type="button"
          className="btn btn-icon fld-ws-remove"
          title={t("fieldsDialog.removeWorkstreamTitle", { name: board.name })}
          aria-label={t("fieldsDialog.removeWorkstreamAria", { name: board.name })}
          disabled={others.length === 0}
          onClick={() => setRemoving(true)}
        >
          <Icon name="i-close" size={13} />
        </button>
      </div>

      <div className="fld-ws-code">
        <div className="field">
          <label htmlFor={repoSelectId}>{t("fieldsDialog.workstreamRepoLabel")}</label>
          <select
            id={repoSelectId}
            className="select"
            aria-label={t("fieldsDialog.workstreamRepoAria", { name: board.name })}
            value={board.repoId ?? ""}
            disabled={folder.busy}
            onChange={(e) => {
              const repoId = e.target.value;
              if (repoId === FROM_FOLDER) {
                void folder.choose().then((added) => added && update.mutate({ id: board.id, patch: { repoId: added.repo.id } }, { onError: fail }));
                return;
              }
              update.mutate({ id: board.id, patch: { repoId: repoId || null, repoPath: repoId ? board.repoPath : "" } }, { onError: fail });
            }}
          >
            <option value="">{t("fieldsDialog.workstreamRepoNone")}</option>
            {(repos.data ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
            <option value={FROM_FOLDER}>{t("fieldsDialog.workstreamRepoFolder")}</option>
          </select>
        </div>
        {repo && (
          <div className="field">
            <label htmlFor={pathId}>{t("fieldsDialog.workstreamRepoPathLabel")}</label>
            <InlineEdit
              id={pathId}
              value={subdir}
              allowEmpty
              aria-label={t("fieldsDialog.workstreamRepoPathAria")}
              className="input num fld-ws-path"
              placeholder={t("fieldsDialog.workstreamRepoPathPlaceholder")}
              onSave={(repoPath) => {
                // A pasted machine path means the folder it names in the checkout, when it is in there.
                const folder = checkout ? repoSubfolder(repoPath, checkout) : isMachinePath(repoPath) ? null : repoPathLabel(repoPath);
                if (folder === null) return toast({ tone: "error", body: t("fieldsDialog.workstreamRepoPathOutside", { folder: repoPath.trim(), checkout: checkout ?? "" }) });
                update.mutate({ id: board.id, patch: { repoPath: folder } }, { onError: fail });
              }}
            />
          </div>
        )}
      </div>

      {repo && <AgentConnection key={repo.id} projectId={projectId} repoId={repo.id} hint />}
      <p className="meta-txt dense fld-ws-where">
        {!repo ? (
          <>
            <span>{t((repos.data ?? []).length ? "fieldsDialog.workstreamWhereNone" : "fieldsDialog.workstreamNoRepos")}</span>
            {repositoriesLink}
          </>
        ) : (
          <>
            <span>
              {subdir
                ? tx("fieldsDialog.workstreamWherePath", { repo: <b>{repo.name}</b>, path: <span className="num">{subdir}/</span> })
                : tx("fieldsDialog.workstreamWhereRoot", { repo: <b>{repo.name}</b> })}
            </span>
            {checkout ? (
              <span className="num fld-ws-checkout" title={checkout}>
                {t("fieldsDialog.workstreamCheckoutAt", { dir: checkout })}
              </span>
            ) : (
              <>
                <span>{t("fieldsDialog.workstreamCheckoutUnset")}</span>
                {repositoriesLink}
              </>
            )}
          </>
        )}
      </p>

      <RemoveWorkstreamDialog
        open={removing}
        onOpenChange={setRemoving}
        board={board}
        count={count}
        repoName={repo?.name ?? null}
        others={others}
        dest={dest}
        onDest={setDest}
        pending={remove.isPending || move.isPending}
        onConfirm={() => (count > 0 ? moveThenRemove() : removeNow())}
      />
    </div>
  );
}

/**
 * The built-in Workstream field's options are the project's boards. Every
 * issue belongs to one, so a workstream that still holds issues asks where
 * they go before it leaves, and the last one never can.
 */
export function WorkstreamEditor({ projectId, items, focusBoardId, onOpenRepositories }: { projectId: string; items: Item[]; focusBoardId?: string | null; onOpenRepositories?: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const boards = useBoards(projectId);
  const create = useCreateBoard(projectId);
  const [newName, setNewName] = useState("");
  const list = boards.data ?? [];
  const editor = useRef<HTMLDivElement>(null);
  const ready = list.some((b) => b.id === focusBoardId);

  // opened for one workstream: bring its card into view, on its repository choice
  useEffect(() => {
    if (!focusBoardId || !ready) return;
    const card = editor.current?.querySelector<HTMLElement>(`.fld-ws[data-board="${focusBoardId}"]`);
    if (!card) return;
    card.scrollIntoView({ block: "center" });
    card.classList.add("is-focus");
    card.querySelector<HTMLElement>("select")?.focus();
  }, [focusBoardId, ready]);

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    create.mutate(
      { name, icon: "i-board" },
      { onSuccess: (b) => (setNewName(""), toast({ body: tx("fieldsDialog.addedWorkstreamToast", { name: <b>{b.name}</b> }) })), onError: (err) => toast(errorSpec(err)) }
    );
  };

  return (
    <div ref={editor} className="fld-editor stack-3" data-editor="workstream">
      <p className="meta-txt dense">{t("fieldsDialog.workstreamNote")}</p>
      <p className="meta-txt dense">
        {t("fieldsDialog.workstreamRepoNote")}
        {onOpenRepositories && (
          <>
            {" "}
            <button type="button" className="link-btn" onClick={onOpenRepositories}>
              {t("fieldsDialog.openRepositories")}
            </button>
          </>
        )}
      </p>
      <div>
        <Eyebrow>{t("fieldsDialog.workstreamsEyebrow")}</Eyebrow>
        <div className="stack-2" style={{ marginTop: "var(--space-2)" }}>
          {list.map((b) => (
            <WorkstreamRow key={b.id} board={b} count={items.filter((i) => i.boardId === b.id).length} others={list.filter((o) => o.id !== b.id)} projectId={projectId} onOpenRepositories={onOpenRepositories} />
          ))}
          <div className="row" style={{ gap: "var(--space-2)" }}>
            <input
              className="input"
              aria-label={t("fieldsDialog.newWorkstreamAria")}
              placeholder={t("fieldsDialog.newWorkstreamPlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (isCommitKey(e)) add();
              }}
            />
            <button type="button" className="btn btn-ghost" disabled={!newName.trim()} onClick={add}>
              <Icon name="i-plus" size={13} /> {t("fieldsDialog.addWorkstream")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
