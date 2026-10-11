import { useEffect, useState } from "react";
import type { ItemStatus, Priority, WorkType } from "@tomradex/domain";
import { Dialog, DialogClose } from "~/components/ui/dialog";
import { PRIORITIES, PRIORITY_LABEL, STATUS, STATUS_KEYS } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { useCreateItem } from "~/lib/queries";
import { useToast } from "~/lib/toast";
import { useWorkspace } from "~/components/workspace/context";
import { ticketMethods, usePlaybooks } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { useToastUndo } from "~/lib/undo";

/** Built-in methods keep their localized names; any other playbook shows its own title. */
const BUILT_IN_METHODS: Record<string, "fields.manualTemplate" | "fields.documentTemplate" | "fields.designTemplate" | "fields.mediaTemplate"> = {
  "task.assist": "fields.manualTemplate",
  "document.write": "fields.documentTemplate",
  "design.create": "fields.designTemplate",
  "media.generate": "fields.mediaTemplate"
};

export function NewIssueDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t, tx } = useI18n();
  const ws = useWorkspace();
  const create = useCreateItem(ws.project.id);
  const undoWrite = useToastUndo(ws.project.id);
  const toast = useToast();
  const playbooks = usePlaybooks(ws.project.id);

  // Whatever the view is filtering on becomes the default, so the issue you just made is still on screen.
  const pinned = (fieldId: string): string[] =>
    ws.query.filter.filter((c) => c.field === fieldId && c.op === "in").flatMap((c) => c.values.filter((v): v is string | number => v !== null).map(String));
  const columnStatuses = (ws.query.columnBy ?? "status") === "status" ? (ws.columnKeys as ItemStatus[]) : STATUS_KEYS;
  // Coding needs a repository to land in; on a workstream without one, a new ticket is general work.
  const typeFor = (boardId: string): WorkType => (ws.boards.find((b) => b.id === boardId)?.repoId ? "coding" : "general");
  const defaults = () => {
    const boardId = pinned("board")[0] ?? ws.boards[0]?.id ?? "";
    const pinnedType = pinned("workType")[0];
    return {
      workType: pinnedType === "general" || pinnedType === "coding" ? pinnedType : typeFor(boardId),
      boardId,
    status: (pinned("status")[0] ?? (columnStatuses.includes("todo") ? "todo" : columnStatuses[0]) ?? "todo") as ItemStatus,
    priority: (pinned("priority").length ? Math.max(...pinned("priority").map(Number)) : 2) as Priority,
      parentId: pinned("epic")[0] ?? ""
    };
  };
  const methods = ticketMethods(playbooks.data, "general");
  const workstreams = ws.boards;
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [template, setTemplate] = useState("task.assist");
  const [workType, setWorkType] = useState<WorkType>(defaults().workType);
  const [boardId, setBoardId] = useState(defaults().boardId);
  const [status, setStatus] = useState<ItemStatus>(defaults().status);
  const [priority, setPriority] = useState<Priority>(defaults().priority);
  const [parentId, setParentId] = useState(defaults().parentId);
  const [templateTouched, setTemplateTouched] = useState(false);
  const [workTypeTouched, setWorkTypeTouched] = useState(false);
  const [recommendationKey, setRecommendationKey] = useState("");
  const [recommendation, setRecommendation] = useState<{ playbookId: string; reason: string; source: string; requires: string[] } | null>(null);

  const statusOptions = columnStatuses;

  // The sheet outlives its own open/close, so it reseeds from whatever the view
  // is showing now rather than from whatever it showed when the workspace mounted.
  useEffect(() => {
    if (!open) return;
    const d = defaults();
    setTitle("");
    setBody("");
    setTemplate(d.workType === "general" ? "task.assist" : "");
    setWorkType(d.workType);
    setBoardId(d.boardId);
    setStatus(d.status);
    setPriority(d.priority);
    setParentId(d.parentId);
    setTemplateTouched(false);
    setWorkTypeTouched(false);
    setRecommendation(null);
    setRecommendationKey("");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const key = `${title.trim()}|${body.trim()}|${workType}`;
    if (!open || templateTouched || title.trim().length < 4 || recommendationKey === key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void invoke("agent.recommendPlaybook", ws.project.id, { title: title.trim(), body: body.trim() || null, ...(workTypeTouched ? { workType } : {}) }).then(result => {
        if (cancelled || !result.playbookId) return;
        if (!workTypeTouched) setWorkType(result.workType);
        setTemplate(result.playbookId);
        setRecommendationKey(`${title.trim()}|${body.trim()}|${result.workType}`);
        setRecommendation({ playbookId: result.playbookId, reason: result.reason, source: result.source, requires: result.requires });
      }).catch(() => undefined);
    }, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, title, body, workType, workTypeTouched, templateTouched, recommendationKey, ws.project.id]);

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    create.mutate(
      { title: trimmed, body: body.trim() || null, playbookId: template || null, boardId, workType, status, priority, parentId: parentId || null, labels: pinned("labels").slice(0, 1) },
      {
        onSuccess: (item) => {
          onOpenChange(false);
          setTitle("");
          toast({ body: <>{tx("newIssueDialog.createdToast", { key: <span className="num">{item.key}</span> })}</>, onUndo: () => undoWrite({ id: item.id, stamp: item.version }) });
        }
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={t("newIssueDialog.dialogLabel")} className="sheet-md">
      <div style={{ padding: "var(--space-4)", borderBottom: "1px solid var(--border)" }}>
        <h2 className="dlg-title">{t("newIssueDialog.title")}</h2>
      </div>
      <div style={{ padding: "var(--space-4)" }} className="stack-3">
        <div className="field">
          <label htmlFor="niWorkType">{t("fields.workType")}</label>
          <select id="niWorkType" className="select" value={workType} onChange={e => {
            const next = e.target.value as WorkType;
            setWorkType(next);
            setWorkTypeTouched(true);
            setTemplateTouched(false);
            setRecommendation(null);
            setRecommendationKey("");
            setTemplate(next === "general" ? "task.assist" : "");
            if (next === "general" && !body.trim()) setBody(t("fields.manualBrief"));
          }}>
            <option value="coding">{t("fields.coding")}</option>
            <option value="general">{t("fields.general")}</option>
          </select>
        </div>
        {workType === "general" && <div className="field">
          <label htmlFor="niTemplate">{t("fields.taskTemplate")}</label>
          <select id="niTemplate" className="select" value={template} onChange={event => {
            const value = event.target.value;
            setTemplate(value);
            setTemplateTouched(true);
            setRecommendation(null);
            setRecommendationKey("");
            const untouched = !body.trim() || (["fields.documentBrief", "fields.designBrief", "fields.mediaBrief", "fields.manualBrief"] as const).some(key => body === t(key));
            if (untouched) setBody(t(value === "document.write" ? "fields.documentBrief" : value === "design.create" ? "fields.designBrief" : value === "media.generate" ? "fields.mediaBrief" : "fields.manualBrief"));
          }}>
            {methods.map((method) => <option key={method.id} value={method.id}>{BUILT_IN_METHODS[method.id] ? t(BUILT_IN_METHODS[method.id]) : method.title}</option>)}
            {template && !methods.some((method) => method.id === template) && <option value={template}>{BUILT_IN_METHODS[template] ? t(BUILT_IN_METHODS[template]) : template}</option>}
          </select>
          {recommendation && <p className="meta-txt" role="status">{t("fields.aiRecommendation")}: {playbooks.data?.find(p => p.id === recommendation.playbookId)?.title ?? recommendation.playbookId} — {recommendation.reason}{recommendation.requires.length ? ` (${t("fields.requiresCapability")}: ${recommendation.requires.join(", ")})` : ""}</p>}
        </div>}
        {recommendation && workType === "coding" && <p className="meta-txt" role="status">{t("fields.aiRecommendation")}: {playbooks.data?.find(p => p.id === recommendation.playbookId)?.title ?? recommendation.playbookId} — {recommendation.reason}</p>}
        <div className="field">
          <label htmlFor="niTitle">{t("newIssueDialog.titleFieldLabel")}</label>
          <input
            id="niTitle"
            autoFocus
            className="input"
            placeholder={t("newIssueDialog.titlePlaceholder")}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
          />
        </div>
        <div className="grid-2">
          <div className="field" style={{ gridColumn: "1 / -1" }}>
            <label htmlFor="niBody">{t("fields.taskBrief")}</label>
            <textarea id="niBody" className="input" rows={4} value={body} onChange={event => setBody(event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="niStatus">{t("newIssueDialog.statusLabel")}</label>
            <select id="niStatus" className="select" value={status} onChange={(e) => setStatus(e.target.value as ItemStatus)}>
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {STATUS[s].label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="niPrio">{t("newIssueDialog.priorityLabel")}</label>
            <select id="niPrio" className="select" value={priority} onChange={(e) => setPriority(Number(e.target.value) as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="niBoard">{t("newIssueDialog.boardLabel")}</label>
            <select id="niBoard" className="select" value={boardId} onChange={(e) => {
              setBoardId(e.target.value);
              if (workTypeTouched || recommendation) return;
              const next = typeFor(e.target.value);
              setWorkType(next);
              if (!templateTouched) setTemplate(next === "general" ? "task.assist" : "");
            }}>
              {workstreams.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="niEpic">{t("newIssueDialog.parentEpicLabel")}</label>
            <select id="niEpic" className="select" value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">{t("newIssueDialog.noneOption")}</option>
              {ws.epics.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.title}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="row" style={{ justifyContent: "flex-end", marginTop: "var(--space-2)" }}>
          <DialogClose asChild>
            <button type="button" className="btn btn-ghost">
              {t("newIssueDialog.cancel")}
            </button>
          </DialogClose>
          <button type="button" className="btn btn-primary" onClick={submit}>
            {t("newIssueDialog.createIssue")}
          </button>
        </div>
      </div>
    </Dialog>
  );
}
