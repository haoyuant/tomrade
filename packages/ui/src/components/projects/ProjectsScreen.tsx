import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueries } from "@tanstack/react-query";
import type { Board, Item, Project } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { Eyebrow, LiveDot, Num, Spacer, Tag } from "~/components/ui/atoms";
import { ThemeSwitch } from "~/components/ui/theme-switch";
import { invoke } from "~/lib/api";
import { agoLabel } from "~/lib/domain";
import { keys, useMcpUrl, useProjects } from "~/lib/queries";
import { NewProjectDialog } from "./NewProjectDialog";
import { OpenProjectDialog } from "./OpenProjectDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";

interface Facts {
  boards: number;
  open: number;
  total: number;
  lastWrite: number | null;
}

/** Counts are read off the project's own rows, so a card can never claim a
 *  number the workspace disagrees with. */
function useProjectFacts(projects: Project[]): Map<string, Facts> {
  const results = useQueries({
    queries: projects.flatMap((p) => [
      { queryKey: keys.boards(p.id), queryFn: () => invoke("boards.list", p.id) },
      { queryKey: keys.items(p.id), queryFn: () => invoke("items.list", { projectId: p.id }) }
    ])
  });
  const facts = new Map<string, Facts>();
  projects.forEach((p, i) => {
    const boards = (results[i * 2]?.data ?? []) as Board[];
    const items = (results[i * 2 + 1]?.data ?? []) as Item[];
    facts.set(p.id, {
      boards: boards.filter((b) => !b.across).length,
      open: items.filter((i2) => i2.status !== "done" && i2.status !== "cancelled").length,
      total: items.length,
      lastWrite: items.length ? Math.max(...items.map((i2) => i2.updatedAt)) : null
    });
  });
  return facts;
}

/* The gear is a sibling of the card, not a child of it: a button inside a button
   is invalid, and the whole card is the button that opens the project. */
function ProjectCard({
  project,
  facts,
  boardNames,
  onOpenSettings
}: {
  project: Project;
  facts?: Facts;
  boardNames: string[];
  onOpenSettings: () => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="proj-cell">
      <button
        type="button"
        className="proj"
        title={`Open ${project.name}`}
        onClick={() => void navigate({ to: "/p/$projectId", params: { projectId: project.id } })}
      >
        <div className="row" style={{ gap: 7 }}>
          <Icon name={project.archived ? "i-archive" : "i-stack"} size={15} style={{ color: project.archived ? "var(--meta)" : "var(--accent)" }} />
          <Eyebrow>{project.archived ? "Archived" : "Active"}</Eyebrow>
        </div>
        <h2 className="proj-name" style={{ marginTop: "var(--space-3)" }}>
          {project.name}
        </h2>
        <p className="proj-desc">{project.description ?? "No description yet."}</p>
        <div className="proj-boards">
          {boardNames.length ? boardNames.map((n) => <Tag key={n} tone="neutral">{n}</Tag>) : <Tag tone="neutral">No boards</Tag>}
        </div>
        <div className="proj-foot">
          <span className="stat-pair">
            <span className="stat-v">{facts?.boards ?? "—"}</span>
            <span className="stat-k">boards</span>
          </span>
          <span className="stat-pair">
            <span className="stat-v plain">{facts?.open ?? "—"}</span>
            <span className="stat-k">open</span>
          </span>
          <span className="stat-pair">
            <span className="stat-v plain">{facts?.total ?? "—"}</span>
            <span className="stat-k">issues</span>
          </span>
          <span className="stat-pair" style={{ marginLeft: "auto", textAlign: "right" }}>
            <span className="stat-k num">{facts?.lastWrite ? agoLabel(facts.lastWrite) : "—"}</span>
            <span className="stat-k">last write</span>
          </span>
        </div>
      </button>
      <button
        type="button"
        className="btn btn-icon proj-gear"
        aria-haspopup="dialog"
        title={`Settings for ${project.name}`}
        aria-label={`Settings for ${project.name}`}
        onClick={onOpenSettings}
      >
        <Icon name="i-gear" size={15} />
      </button>
    </div>
  );
}

export function ProjectsScreen() {
  const navigate = useNavigate();
  const projects = useProjects();
  const mcp = useMcpUrl();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [openOpen, setOpenOpen] = useState(false);
  /** Held by id, and looked up live: deleting the project is what closes the sheet. */
  const [configuring, setConfiguring] = useState<string | null>(null);
  const list = projects.data ?? [];
  const facts = useProjectFacts(list);

  // the gear advertises ⌘, — a shortcut with no handler is a broken promise
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const boardQueries = useQueries({
    queries: list.map((p) => ({ queryKey: keys.boards(p.id), queryFn: () => invoke("boards.list", p.id) }))
  });

  return (
    <div className="app">
      <header className="titlebar">
        <span className="crumb-title">Tomrade</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-title" style={{ color: "var(--muted)" }}>
          Projects
        </span>
        <Spacer />
        <button type="button" className="btn btn-secondary no-drag" onClick={() => setOpenOpen(true)}>
          <Icon name="i-search" size={14} /> Open a project…
        </button>
        <button type="button" className="btn btn-primary no-drag" onClick={() => setNewOpen(true)}>
          <Icon name="i-plus" size={14} /> New project
        </button>
        <button type="button" className="btn btn-icon no-drag" title="Settings — ⌘," aria-label="Settings" onClick={() => setSettingsOpen(true)}>
          <Icon name="i-gear" size={17} />
        </button>
      </header>

      <main className="sheet">
        <div className="wrap wrap-wide">
          <div className="sec-head">
            <div>
              <h1 className="sec-title">Projects</h1>
              <p className="sec-lede" style={{ marginTop: 4 }}>
                Every project is a workspace on this machine. Each board is a workstream that owns its issues; views slice a board without moving
                anything. A project can publish a copy of itself to a folder or a repository — open one here to work on it too.
              </p>
            </div>
          </div>

          <div className="proj-grid">
            {list.map((p, i) => (
              <ProjectCard
                key={p.id}
                project={p}
                facts={facts.get(p.id)}
                boardNames={(boardQueries[i]?.data ?? []).filter((b) => !b.across).map((b) => b.name)}
                onOpenSettings={() => setConfiguring(p.id)}
              />
            ))}
            <button type="button" className="proj-new" onClick={() => setNewOpen(true)}>
              <Icon name="i-plus" size={20} />
              <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-lg)", color: "inherit" }}>New project</span>
              <span style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--meta)" }}>
                Creates a “Main” board and the two cross-board scopes.
              </span>
            </button>
          </div>

          <hr className="rule" />
          <div className="sec-head">
            <div>
              <h2 className="sec-title">Agents</h2>
              <p className="sec-lede" style={{ marginTop: 4 }}>
                Coding agents read and write this backlog over MCP. Their writes carry provenance and stay reversible.
              </p>
            </div>
          </div>
          <div className="grid-2">
            <div className="panel">
              <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
                <LiveDot />
                <Eyebrow>MCP server · listening</Eyebrow>
              </div>
              <p className="num" style={{ fontSize: 14, color: "var(--fg-2)" }}>
                {mcp.data ?? "not running"}
              </p>
              <p className="meta-txt dense" style={{ marginTop: "var(--space-3)" }}>
                Point Claude Code, Cline or any MCP client at this endpoint to list, read and write issues.
              </p>
            </div>
            <div className="panel">
              <Eyebrow style={{ marginBottom: "var(--space-3)" }}>Tools exposed</Eyebrow>
              <ul className="dash">
                <li>
                  <Num>list_boards</Num> · <Num>list_items</Num> · <Num>get_item</Num> · <Num>create_item</Num>
                </li>
                <li>
                  <Num>update_item</Num> — optimistic lock on <Num>baseVersion</Num>
                </li>
                <li>
                  <Num>change_status</Num> · <Num>delete_item</Num>
                </li>
                <li>Writes on human-locked items are rejected, not merged</li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      <StatusBar>
        <ThemeSwitch compact />
      </StatusBar>

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
      <OpenProjectDialog
        open={openOpen}
        onOpenChange={setOpenOpen}
        onOpened={(projectId) => void navigate({ to: "/p/$projectId", params: { projectId } })}
      />
      <ProjectSettingsDialog
        project={list.find((p) => p.id === configuring) ?? null}
        projects={list}
        onOpenChange={(open) => !open && setConfiguring(null)}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
