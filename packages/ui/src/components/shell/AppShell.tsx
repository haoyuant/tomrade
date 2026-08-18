import type { ReactNode } from "react";
import { BTN } from "~/lib/design-system";

export function AppShell({
  mcpUrl,
  onUndo,
  onNewTicket,
  onNewEpic,
  children,
}: {
  mcpUrl: string | null;
  onUndo: () => void;
  onNewTicket: () => void;
  onNewEpic: () => void;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col bg-slate-950">
      <header className="flex items-center gap-3 border-b border-slate-800 bg-slate-900 px-4 py-2.5">
        <h1 className="text-sm font-bold text-slate-100">Tomrade</h1>
        {mcpUrl && (
          <span className="hidden items-center gap-1.5 rounded-full bg-emerald-950 border border-emerald-800 px-2 py-0.5 text-[10px] text-emerald-300 md:inline-flex" title={mcpUrl}>
            ● MCP {mcpUrl.replace("http://", "")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className={BTN.secondary} onClick={onUndo}>↩ Undo</button>
          <button type="button" className={BTN.secondary} onClick={onNewEpic}>+ Epic</button>
          <button type="button" className={BTN.primary} onClick={onNewTicket}>+ Ticket</button>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
