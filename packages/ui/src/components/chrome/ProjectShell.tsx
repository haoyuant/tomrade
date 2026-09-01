import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Outlet, useNavigate, useParams } from "@tanstack/react-router";
import type { FocusRef } from "@tomrade/agent";
import { AgentPanel, aiOpenKey } from "~/components/workspace/AgentPanel";
import { usePanelOpen } from "~/lib/panel";

/**
 * What the mounted screen teaches the global panel while it is on screen. The
 * panel itself never unmounts inside a project — screens come and go under it.
 */
export interface ScreenBinding {
  /** How panel chips open an issue here; the default navigates to the issue screen. */
  openIssue?: (id: string) => void;
  openSettings?: () => void;
  /** What the user is looking at right now — snapshotted onto each message they send. */
  focus?: FocusRef[];
}

interface DockValue {
  aiOpen: boolean;
  setAiOpen: (next: boolean | ((current: boolean) => boolean)) => void;
  bind: (binding: ScreenBinding) => () => void;
}

const Ctx = createContext<DockValue | null>(null);

export function useAgentDock(): DockValue {
  const value = useContext(Ctx);
  if (!value) throw new Error("useAgentDock outside a ProjectShell");
  return value;
}

/** Screens declare their panel wiring for as long as they are mounted. Memoize the binding — it re-binds by identity. */
export function useScreenBinding(binding: ScreenBinding): void {
  const { bind } = useAgentDock();
  useEffect(() => bind(binding), [bind, binding]);
}

/**
 * The layout above every project route: the screen on the left, one persistent
 * assistant on the right. Hoisted here so navigating between the board and an
 * issue keeps the panel's draft, live stream and scroll — the thread model was
 * always project-scoped; now the mount is too.
 */
export function ProjectShell() {
  const { projectId } = useParams({ strict: false }) as { projectId: string };
  const navigate = useNavigate();
  const [aiOpen, setAiOpen] = usePanelOpen(aiOpenKey);
  const [binding, setBinding] = useState<ScreenBinding | null>(null);

  const bind = useCallback((next: ScreenBinding) => {
    setBinding(next);
    return () => setBinding((current) => (current === next ? null : current));
  }, []);

  // ⌘J is chrome, not screen behavior: the panel toggles from every screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAiOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setAiOpen]);

  const openIssue = useCallback(
    (id: string) => {
      if (binding?.openIssue) binding.openIssue(id);
      else void navigate({ to: "/p/$projectId/i/$itemId", params: { projectId, itemId: id } });
    },
    [binding, navigate, projectId]
  );
  const openSettings = useCallback(() => binding?.openSettings?.(), [binding]);

  const value = useMemo<DockValue>(() => ({ aiOpen, setAiOpen, bind }), [aiOpen, setAiOpen, bind]);

  return (
    <Ctx.Provider value={value}>
      <div className="shell">
        <div className="shell-main">
          <Outlet />
        </div>
        <AgentPanel
          key={projectId}
          open={aiOpen}
          onToggle={setAiOpen}
          projectId={projectId}
          focus={binding?.focus ?? []}
          onOpenSettings={openSettings}
          onOpenIssue={openIssue}
        />
      </div>
    </Ctx.Provider>
  );
}
