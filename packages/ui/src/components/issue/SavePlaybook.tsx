import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { PlaybookDraft } from "@tomradex/agent";
import type { Item } from "@tomradex/domain";
import { useAgentThreads, usePlaybooks } from "~/lib/agent";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { keys } from "~/lib/queries";
import { errorSpec, useToast } from "~/lib/toast";

/**
 * On accepted work an agent did: draft its method as a playbook. The draft is
 * the person's to edit; nothing is written until they press Save.
 */
export function SavePlaybook({ item }: { item: Item }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const threads = useAgentThreads(item.projectId);
  const playbooks = usePlaybooks(item.projectId);
  const [draft, setDraft] = useState<PlaybookDraft | null>(null);
  const [text, setText] = useState("");
  const [id, setId] = useState("");
  const [scope, setScope] = useState<"user" | "project">("user");
  const [busy, setBusy] = useState(false);
  const agentWorked = (threads.data ?? []).some((th) => th.itemId === item.id) || item.evidence.submissions.some((s) => s.submittedBy !== "human");
  if (item.kind !== "ticket" || item.status !== "done" || !agentWorked) return null;

  const start = async () => {
    setBusy(true);
    try {
      const next = await invoke("agent.draftPlaybook", item.projectId, item.id);
      setDraft(next);
      setText(next.text);
      setId(next.id);
    } catch (error) {
      toast(errorSpec(error));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const saved = await invoke("agent.savePlaybookDraft", { projectId: item.projectId, itemId: item.id, text, scope, id: id.trim() || undefined, runId: draft.runId });
      await qc.invalidateQueries({ queryKey: keys.agent.playbooksAll });
      toast({ body: t("playbooks.savedFromTicket", { id: saved.id, n: saved.version }) });
      setDraft(null);
    } catch (error) {
      toast(errorSpec(error));
    } finally {
      setBusy(false);
    }
  };

  const existing = (playbooks.data ?? []).filter((p) => p.source !== "plugin");
  const replaces = existing.find((p) => p.id === id.trim());

  if (!draft)
    return (
      <div className="row">
        <button className="btn btn-ghost" type="button" data-testid="save-playbook" disabled={busy} onClick={() => void start()}>
          {busy ? t("playbooks.drafting") : t("playbooks.saveAsPlaybook")}
        </button>
      </div>
    );
  return (
    <div className="stack-2" data-testid="save-playbook-draft">
      <span className="meta-txt">{t("playbooks.draftLede")}</span>
      <textarea className="input" rows={14} aria-label={t("playbooks.saveAsPlaybook")} value={text} onChange={(e) => setText(e.target.value)} style={{ fontFamily: "var(--font-mono)" }} />
      <div className="row" style={{ flexWrap: "wrap" }}>
        <input className="input" style={{ maxWidth: 220 }} list={`playbook-ids-${item.id}`} aria-label={t("playbooks.draftId")} placeholder={t("playbooks.draftId")} value={id} onChange={(e) => setId(e.target.value)} />
        <datalist id={`playbook-ids-${item.id}`}>
          {existing.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title}
            </option>
          ))}
        </datalist>
        <select className="input" style={{ maxWidth: 200 }} aria-label={t("playbooks.importInto")} value={scope} onChange={(e) => setScope(e.target.value as "user" | "project")}>
          <option value="user">{t("playbooks.importScopeUser")}</option>
          <option value="project">{t("playbooks.draftScopeProject")}</option>
        </select>
        <button className="btn btn-primary" type="button" disabled={busy || !text.trim()} onClick={() => void save()}>
          {t("playbooks.draftSave")}
        </button>
        <button className="btn btn-ghost" type="button" disabled={busy} onClick={() => setDraft(null)}>
          {t("common.cancel")}
        </button>
      </div>
      {replaces && <span className="meta-txt">{t("playbooks.draftNewVersion", { title: replaces.title })}</span>}
    </div>
  );
}
