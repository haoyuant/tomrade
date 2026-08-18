import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { cn } from "~/lib/utils";
import { BTN, INPUT, SURFACE, TEXT } from "~/lib/design-system";
import type { Project } from "@tomrade/core";

function NewProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string) => void }) {
  const [name, setName] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div className="flex w-full max-w-md flex-col gap-4 rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-sm font-semibold text-slate-100">New Project</h2>
        <input autoFocus className={INPUT} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) onCreate(name.trim()); }} placeholder="Project name…" />
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN.secondary} onClick={onClose}>Cancel</button>
          <button type="button" className={BTN.primary} disabled={!name.trim()} onClick={() => onCreate(name.trim())}>Create</button>
        </div>
      </div>
    </div>
  );
}

export function ProjectsView({ mcpUrl, onOpen, onOpenSettings }: { mcpUrl: string | null; onOpen: (project: Project) => void; onOpenSettings: () => void }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => window.tomrade.projectsList() });
  const create = useMutation({
    mutationFn: (name: string) => window.tomrade.projectsCreate({ name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] })
  });
  const remove = useMutation({
    mutationFn: (id: string) => window.tomrade.projectsRemove(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["projects"] })
  });
  const [showNew, setShowNew] = useState(false);

  return (
    <div className="flex h-full flex-col bg-slate-950">
      <header className="app-drag flex items-center gap-3 border-b border-slate-800 bg-slate-900 py-3 pl-20 pr-6">
        <h1 className="text-base font-bold text-slate-100">Tomrade</h1>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={cn(BTN.ghost, "app-no-drag !px-2")} onClick={onOpenSettings} title="Settings">⚙</button>
          <button type="button" className={cn(BTN.primary, "app-no-drag")} onClick={() => setShowNew(true)}>+ New Project</button>
        </div>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto p-6">
        <h2 className={cn(TEXT.muted, "mb-4 text-sm font-medium")}>Projects</h2>
        {projects.isLoading && <p className="text-sm text-slate-500">Loading…</p>}
        {projects.error && <p className="text-sm text-red-400">{String(projects.error)}</p>}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {(projects.data ?? []).map((p) => (
            <div key={p.id} className={cn("group flex cursor-pointer flex-col gap-2 rounded-lg border border-slate-800 bg-slate-900 p-5 transition-colors hover:border-sky-600 hover:bg-slate-800/60")} onClick={() => onOpen(p)}>
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-slate-100">{p.name}</h3>
                <button
                  type="button"
                  className="rounded px-1.5 text-xs text-slate-500 opacity-0 transition-opacity hover:bg-red-950 hover:text-red-300 group-hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); if (window.confirm("Delete project and all its items?")) remove.mutate(p.id); }}
                >
                  ✕
                </button>
              </div>
              {p.description && <p className="line-clamp-2 text-xs text-slate-500">{p.description}</p>}
              <span className="mt-2 text-[10px] uppercase tracking-wide text-slate-600">Open →</span>
            </div>
          ))}
          {projects.data?.length === 0 && <p className="col-span-full text-sm text-slate-500">No projects yet — create your first one.</p>}
        </div>
      </main>
      <footer className="flex items-center justify-between border-t border-slate-800 bg-slate-900 px-6 py-1.5">
        <span className="text-[10px] text-slate-600">Tomrade · local-first backlog</span>
        {mcpUrl && (
          <span className="inline-flex items-center gap-1.5 text-[10px] text-slate-400" title={mcpUrl}>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
            MCP <span className="text-slate-500">{mcpUrl.replace("http://", "")}</span>
          </span>
        )}
      </footer>
      {showNew && <NewProjectModal onClose={() => setShowNew(false)} onCreate={(name) => { create.mutate(name, { onSuccess: () => setShowNew(false) }); }} />}
    </div>
  );
}