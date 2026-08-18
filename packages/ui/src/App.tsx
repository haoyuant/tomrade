import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "./components/shell/AppShell.js";
import { Board } from "./components/board/Board.js";
import { ItemDetail } from "./components/detail/ItemDetail.js";
import { AiAssistant } from "./components/ai/AiAssistant.js";
import { ProjectsView } from "./components/projects/ProjectsView.js";
import { INPUT, BTN } from "./lib/design-system.js";
import { useCreateItem, useItems, useUndo } from "./lib/queries.js";
import type { Item, Project } from "@tomrade/core";

function NewItemModal({
  projectId,
  defaultKind,
  onClose,
}: {
  projectId: string;
  defaultKind: "ticket" | "epic";
  onClose: () => void;
}) {
  const create = useCreateItem(projectId);
  const { data } = useItems(projectId);
  const [title, setTitle] = useState("");
  const [parentId, setParentId] = useState("");

  const submit = () => {
    if (!title.trim()) return;
    create.mutate(
      { title: title.trim(), kind: defaultKind, parentId: parentId || null },
      { onSuccess: onClose }
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-slate-100">New {defaultKind === "epic" ? "Epic" : "Ticket"}</h2>
        <input
          autoFocus
          className={INPUT}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
          placeholder={defaultKind === "epic" ? "Epic title…" : "Ticket title (one PR)…"}
        />
        {defaultKind === "ticket" && (
          <label className="flex flex-col gap-1 text-xs text-slate-400">
            Parent epic
            <select className={INPUT} value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">(none)</option>
              {(data ?? []).filter((i) => i.kind === "epic").map((e) => (
                <option key={e.id} value={e.id}>{e.title}</option>
              ))}
            </select>
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN.secondary} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN.primary} onClick={submit}>Create</button>
        </div>
      </div>
    </div>
  );
}

function Workspace({
  project,
  onBack,
  mcpUrl,
}: {
  project: Project;
  onBack: () => void;
  mcpUrl: string | null;
}) {
  const undo = useUndo();
  const [selected, setSelected] = useState<Item | null>(null);
  const [newKind, setNewKind] = useState<"ticket" | "epic" | null>(null);

  return (
    <AppShell
      projectName={project.name}
      onBack={onBack}
      mcpUrl={mcpUrl}
      onUndo={() => undo.mutate()}
      onNewTicket={() => setNewKind("ticket")}
      onNewEpic={() => setNewKind("epic")}
    >
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Board projectId={project.id} onCardClick={setSelected} />
        </div>
        <AiAssistant projectId={project.id} />
      </div>
      {selected && <ItemDetail item={selected} onClose={() => setSelected(null)} />}
      {newKind && <NewItemModal projectId={project.id} defaultKind={newKind} onClose={() => setNewKind(null)} />}
    </AppShell>
  );
}

export function App() {
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => window.tomrade.mcpUrl() });
  const [project, setProject] = useState<Project | null>(null);

  if (!project) {
    return <ProjectsView mcpUrl={mcp.data ?? null} onOpen={setProject} />;
  }
  return <Workspace project={project} onBack={() => setProject(null)} mcpUrl={mcp.data ?? null} />;
}
