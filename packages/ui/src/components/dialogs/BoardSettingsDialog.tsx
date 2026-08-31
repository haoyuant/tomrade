import { useEffect, useMemo, useState } from "react";
import type { ItemStatus } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Num, Tag } from "~/components/ui/atoms";
import { BOARD_GLYPHS, GROUPS, PRIORITY_LABEL, PROVENANCE, STATUS, STATUS_FILL, STATUS_KEYS, provenanceOf, queryFromView } from "~/lib/domain";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useMoveItemsToBoard, useRemoveView, useUpdateBoard, useUpdateView } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace, viewCount } from "~/components/workspace/context";
import type { View } from "@tomrade/domain";

/** What a view resolves to, in one line, so a roster row can never advertise
 *  something the board disagrees with. */
function viewDefinition(view: View, epicNames: Map<string, string>, t: (key: MessageKey, vars?: Record<string, string | number>) => string): string {
  const f = view.filter ?? {};
  const bits = [t("boardSettingsDialog.defGroupedBy", { group: GROUPS[view.groupBy].label.toLowerCase() })];
  if (f.labels?.length) bits.push(t("boardSettingsDialog.defLabels", { list: f.labels.join(", ") }));
  if (f.epics?.length) {
    const noneWord = t("boardSettingsDialog.noneWord");
    const epicFallback = t("boardSettingsDialog.epicFallback");
    bits.push(t("boardSettingsDialog.defEpics", { list: f.epics.map((e) => (e === "none" ? noneWord : (epicNames.get(e) ?? epicFallback))).join(", ") }));
  }
  if (f.priorities?.length) bits.push(t("boardSettingsDialog.defPriority", { list: f.priorities.map((p) => PRIORITY_LABEL[p]).join(", ") }));
  if (f.provenance?.length) bits.push(t("boardSettingsDialog.defLastWrite", { list: f.provenance.map((p) => PROVENANCE[p]).join(", ") }));
  bits.push(t("boardSettingsDialog.defColumns", { n: view.columns.length }));
  const wip = Object.entries(view.wip ?? {});
  if (wip.length) bits.push(t("boardSettingsDialog.defWip", { list: wip.map(([k, n]) => `${STATUS[k as ItemStatus]?.label.toLowerCase() ?? k} ${n}`).join(", ") }));
  return bits.join(" · ");
}

/**
 * A board owns its issues; a view is a slice of one board. So this sheet answers
 * only for what the board itself owns — its name, its glyph, the package it
 * mirrors, the issues carrying its id, and the roster of views saved on it.
 */
export function BoardSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const updateBoard = useUpdateBoard(ws.project.id);
  const updateView = useUpdateView(ws.project.id);
  const removeView = useRemoveView(ws.project.id);
  const moveItems = useMoveItemsToBoard(ws.project.id);
  const toast = useToast();

  const others = ws.boards.filter((b) => !b.across && b.id !== ws.board.id);
  const [name, setName] = useState(ws.board.name);
  const [icon, setIcon] = useState<IconId>(ws.board.icon as IconId);
  const [subtitle, setSubtitle] = useState(ws.board.subtitle ?? "");
  const [scope, setScope] = useState("all");
  const [dest, setDest] = useState(others[0]?.id ?? "");
  /** Roster edits are a draft: Save writes them, Cancel discards them. */
  const [roster, setRoster] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setName(ws.board.name);
    setIcon(ws.board.icon as IconId);
    setSubtitle(ws.board.subtitle ?? "");
    setScope("all");
    setDest(others[0]?.id ?? "");
    setRoster(ws.boardViews.map((v) => v.id));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const owned = ws.owned;
  const distribution = STATUS_KEYS.map((k) => ({ k, n: owned.filter((i) => i.status === k).length })).filter((d) => d.n > 0);
  const aiWrites = owned.filter((i) => provenanceOf(i) === "ai").length;
  const locked = owned.filter((i) => provenanceOf(i) === "locked").length;

  /* every option carries the count it would move, so the control never offers
     a scope without saying how much work it touches */
  const scopes = useMemo(() => {
    const rows = [{ value: "all", label: t("boardSettingsDialog.allIssues", { n: owned.length }) }];
    for (const k of STATUS_KEYS) {
      const n = owned.filter((i) => i.status === k).length;
      if (n) rows.push({ value: `s:${k}`, label: t("boardSettingsDialog.statusScope", { label: STATUS[k].label, n }) });
    }
    for (const l of [...new Set(owned.flatMap((i) => i.labels))].sort()) {
      rows.push({ value: `l:${l}`, label: t("boardSettingsDialog.labelScope", { label: l, n: owned.filter((i) => i.labels.includes(l)).length }) });
    }
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owned, t]);

  const matching = owned.filter((i) => (scope === "all" ? true : scope.startsWith("s:") ? i.status === scope.slice(2) : i.labels.includes(scope.slice(2))));
  const destBoard = ws.boards.find((b) => b.id === dest);

  const move = () => {
    if (!destBoard || !matching.length) return;
    moveItems.mutate(
      { from: ws.board.id, to: destBoard.id, itemIds: matching.map((i) => i.id) },
      { onSuccess: (n) => toast({ body: <>{tx("boardSettingsDialog.movedToast", { n: <span className="num">{n}</span>, name: destBoard.name })}</> }) }
    );
  };

  const rosterViews = roster.map((id) => ws.boardViews.find((v) => v.id === id)).filter((v): v is View => !!v);

  const save = () => {
    updateBoard.mutate({ id: ws.board.id, patch: { name: name.trim() || ws.board.name, icon, subtitle: subtitle.trim() || null } });
    // rank carries the roster order, so the first row is the view that opens first
    rosterViews.forEach((v, i) => updateView.mutate({ id: v.id, patch: { rank: i } }));
    for (const v of ws.boardViews) if (!roster.includes(v.id)) removeView.mutate(v.id);
    if (!roster.includes(ws.view.id)) ws.openSpace(ws.board.id, roster[0]);
    onOpenChange(false);
    toast({ body: <>{tx("boardSettingsDialog.savedToast", { name: <span className="num">{name.trim() || ws.board.name}</span> })}</> });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("boardSettingsDialog.dialogLabel")} className="sheet-board">
      <DialogHead title={t("boardSettingsDialog.dialogLabel")} aside={<Tag tone="neutral">{subtitle || name}</Tag>} />
      <DialogBody className="stack-4">
        <div className="field">
          <label htmlFor="bsName">{t("boardSettingsDialog.boardNameLabel")}</label>
          <input id="bsName" autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="bsIcon">{t("boardSettingsDialog.sidebarGlyphLabel")}</label>
            <select id="bsIcon" className="select" value={icon} onChange={(e) => setIcon(e.target.value as IconId)}>
              {BOARD_GLYPHS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="bsPkg">{t("boardSettingsDialog.workspacePkgLabel")}</label>
            <input
              id="bsPkg"
              className="input num"
              placeholder={t("boardSettingsDialog.workspacePkgPlaceholder")}
              value={subtitle}
              onChange={(e) => setSubtitle(e.target.value)}
            />
          </div>
        </div>

        <div>
          <Eyebrow>{t("boardSettingsDialog.issuesOnBoard")}</Eyebrow>
          <p className="meta-txt dense" style={{ margin: "6px 0 var(--space-3)" }}>
            {tx("boardSettingsDialog.issuesCarryBoardId", {
              n: <Num>{owned.length}</Num>,
              boardId: <Num>board_id = {ws.board.id.slice(0, 8)}</Num>
            })}
            {aiWrites > 0 && tx("boardSettingsDialog.aiWritesClause", { n: <Num>{aiWrites}</Num> })}
            {locked > 0 && tx("boardSettingsDialog.lockedClause", { n: <Num>{locked}</Num> })}.
          </p>
          <div className="bs-bar" role="img" aria-label={distribution.map((d) => `${STATUS[d.k].label} ${d.n}`).join(", ")}>
            {distribution.map((d) => (
              <span key={d.k} style={{ flex: d.n, background: STATUS_FILL[d.k] }} />
            ))}
          </div>
          <div className="bs-legend">
            {distribution.map((d) => (
              <span className="bs-dl" key={d.k}>
                <i style={{ background: STATUS_FILL[d.k] }} />
                {STATUS[d.k].label} <span className="num">{d.n}</span>
              </span>
            ))}
          </div>
        </div>

        <div>
          <Eyebrow>{t("boardSettingsDialog.moveToAnotherBoard")}</Eyebrow>
          <div className="row" style={{ marginTop: "var(--space-2)", gap: "var(--space-2)" }}>
            <select
              className="select"
              style={{ flex: 1, minWidth: 0 }}
              aria-label={t("boardSettingsDialog.whichIssuesAria")}
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              {scopes.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              className="select"
              style={{ flex: 1, minWidth: 0 }}
              aria-label={t("boardSettingsDialog.destinationBoardAria")}
              value={dest}
              onChange={(e) => setDest(e.target.value)}
            >
              {others.map((b) => (
                <option key={b.id} value={b.id}>
                  → {b.name}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-secondary" disabled={!matching.length || !destBoard} onClick={move}>
              {t("boardSettingsDialog.moveButton")}
            </button>
          </div>
          <p className="meta-txt dense" style={{ marginTop: 6 }}>
            {!destBoard ? (
              t("boardSettingsDialog.noOtherBoard")
            ) : (
              <>
                {t("boardSettingsDialog.moveCount", { n: matching.length })} {t("boardSettingsDialog.moveNote")}
              </>
            )}
          </p>
        </div>

        <div>
          <Eyebrow>{t("boardSettingsDialog.savedViews")}</Eyebrow>
          <div style={{ marginTop: "var(--space-2)" }}>
            {rosterViews.map((view, i) => (
              <div className="cfg-row" key={view.id}>
                <input
                  className="bs-radio"
                  type="radio"
                  name="bsDefault"
                  checked={i === 0}
                  aria-label={t("boardSettingsDialog.openFirstAria", { name: view.name })}
                  onChange={() => setRoster((r) => [view.id, ...r.filter((id) => id !== view.id)])}
                />
                <span className="bs-stack">
                  <span className="cfg-name">{view.name}</span>
                  <span className="bs-sub">
                    {i === 0 ? t("boardSettingsDialog.opensFirst") : ""}
                    {viewDefinition(view, ws.epicNames, t)}
                  </span>
                </span>
                <span className="meta-txt num">{viewCount(ws.items, ws.board, view, [...ws.epics.map((e) => e.id), "none"])}</span>
                <button
                  type="button"
                  className="btn btn-icon"
                  title={t("boardSettingsDialog.removeFromBoardTitle")}
                  aria-label={t("boardSettingsDialog.removeFromBoardAria", { name: view.name })}
                  disabled={roster.length < 2}
                  onClick={() => setRoster((r) => r.filter((id) => id !== view.id))}
                >
                  <Icon name="i-close" size={14} />
                </button>
              </div>
            ))}
            <p className="meta-txt" style={{ marginTop: "var(--space-3)" }}>
              {t("boardSettingsDialog.rosterCount", { n: roster.length })}
            </p>
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            {t("boardSettingsDialog.rosterNote")}
          </p>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={() => onOpenChange(false)}>
          {t("boardSettingsDialog.cancel")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={save}>
          {t("boardSettingsDialog.saveBoard")}
        </button>
      </DialogFoot>
    </Dialog>
  );
}

export { queryFromView };
