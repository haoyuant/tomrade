import type { ReactNode } from "react";
import { BTN } from "~/lib/design-system";

export function AppShell({
  projectName,
  onBack,
  mcpUrl,
  onUndo,
  onNewTicket,
  onNewEpic,
  children,
}: {
  projectName: string;
  onBack: () => void;
  mcpUrl: string | null;
  onUndo: () => void;
  onNewTicket: () => void;
  onNewEpic: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-slate-950">
      <header className="app-drag flex items-center gap-3 border-b border-slate-800 bg-slate-900 py-2.5 pl-20 pr-4">
        <button type="button" onClick={onBack} className="app-no-drag rounded px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-200" title="Back to projects">← Projects</button>
        <h1 className="text-sm font-bold text-slate-100">{projectName}</h1>
        {mcpUrl && (
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-950 border border-emerald-800 px-2 py-0.5 text-[10px] text-emerald-300 md:inline-flex" title={mcpUrl}>
            ● MCP {mcpUrl.replace("http://", "")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN.secondary + " app-no-drag"} onClick={onUndo}>↩ Undo</button>
          <button type="button" className={BTN.secondary + " app-no-drag"} onClick={onNewEpic}>+ Epic</button>
          <button type="button" className={BTN.primary + " app-no-drag"} onClick={onNewTicket}>+ Ticket</button>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col">{children}</main>
    </div>
  );
}