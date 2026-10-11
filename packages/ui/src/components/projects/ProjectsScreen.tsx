import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQueries, useQueryClient } from "@tanstack/react-query";
import type { Board, Item, Project } from "@tomradex/domain";
import { Icon } from "~/components/icons";
import { SettingsDialog } from "~/components/dialogs/SettingsDialog";
import { StatusBar } from "~/components/chrome/StatusBar";
import { Eyebrow, LiveDot, Num, Spacer, Tag } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { agoLabel } from "~/lib/domain";
import { useI18n } from "~/lib/i18n";
import { keys, useHubInfo, useMcpUrl, useProjects, useRestores, useSettingsSections } from "~/lib/queries";
import { useSeen } from "~/lib/onboarding";
import { useToast } from "~/lib/toast";
import { HubSetup } from "./HubSetup";
import { NewProjectDialog } from "./NewProjectDialog";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog";
import { RestoreBanner, RestoreCard, useRestoredToasts } from "./RestoreCards";

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
      boards: boards.length,
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
  const { t } = useI18n();
  return (
    <div className="proj-cell">
      <button
        type="button"
        className="proj"
        title={t("projectsScreen.openProjectTitle", { name: project.name })}
        onClick={() => void navigate({ to: "/p/$projectId", params: { projectId: project.id } })}
      >
        <div className="row" style={{ gap: 7 }}>
          <Icon name={project.archived ? "i-archive" : "i-stack"} size={15} style={{ color: project.archived ? "var(--meta)" : "var(--accent)" }} />
          <Eyebrow>{project.archived ? t("projectsScreen.archived") : t("projectsScreen.active")}</Eyebrow>
          {project.sample && <Tag tone="strong">{t("onboarding.sampleTag")}</Tag>}
        </div>
        <h2 className="proj-name" style={{ marginTop: "var(--space-3)" }}>
          {project.name}
        </h2>
        <p className="proj-desc">{project.description ?? t("projectsScreen.noDescription")}</p>
        <div className="proj-boards">
          {boardNames.length ? boardNames.map((n) => <Tag key={n} tone="neutral">{n}</Tag>) : <Tag tone="neutral">{t("projectsScreen.noBoards")}</Tag>}
        </div>
        <div className="proj-foot">
          <span className="stat-pair">
            <span className="stat-v">{facts?.boards ?? "—"}</span>
            <span className="stat-k">{t("projectsScreen.boardsStat")}</span>
          </span>
          <span className="stat-pair">
            <span className="stat-v plain">{facts?.open ?? "—"}</span>
            <span className="stat-k">{t("projectsScreen.openStat")}</span>
          </span>
          <span className="stat-pair">
            <span className="stat-v plain">{facts?.total ?? "—"}</span>
            <span className="stat-k">{t("projectsScreen.issuesStat")}</span>
          </span>
          <span className="stat-pair" style={{ marginLeft: "auto", textAlign: "right" }}>
            <span className="stat-k num">{facts?.lastWrite ? agoLabel(facts.lastWrite) : "—"}</span>
            <span className="stat-k">{t("projectsScreen.lastWriteStat")}</span>
          </span>
        </div>
      </button>
      <button
        type="button"
        className="btn btn-icon proj-gear"
        aria-haspopup="dialog"
        title={t("projectsScreen.settingsForTitle", { name: project.name })}
        aria-label={t("projectsScreen.settingsForTitle", { name: project.name })}
        onClick={onOpenSettings}
      >
        <Icon name="i-gear" size={15} />
      </button>
    </div>
  );
}

/** The home grid, or — before the Hub folder exists — the one question that comes first. */
export function ProjectsScreen() {
  const hub = useHubInfo();
  if (hub.data && !hub.data.configured) return <HubSetup />;
  return <ProjectsHome />;
}

function ProjectsHome() {
  const navigate = useNavigate();
  const { t, locale } = useI18n();
  const qc = useQueryClient();
  const toast = useToast();
  const projects = useProjects();
  // The onboarding plugin is what makes the sample; its settings section says it is loaded.
  const sections = useSettingsSections();
  const { seen, markSeen } = useSeen();
  const sample = useMutation({
    mutationFn: () => invoke("onboarding.createSample", locale),
    onSuccess: (project) => {
      void qc.invalidateQueries({ queryKey: keys.projects });
      void navigate({ to: "/p/$projectId", params: { projectId: project.id } });
    },
    onError: (err) => toast({ body: err instanceof Error ? err.message : String(err) })
  });
  const mcp = useMcpUrl();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  /** Held by id, and looked up live: deleting the project is what closes the sheet. */
  const [configuring, setConfiguring] = useState<string | null>(null);
  const list = projects.data ?? [];
  const facts = useProjectFacts(list);
  const offerSample = !!projects.data && !list.some((p) => p.sample) && !!sections.data?.some((s) => s.id === "onboarding") && !seen("sample-tile");
  // Projects in the account that are not on this computer yet stand in the grid too, saying where they are.
  const restores = useRestores();
  const missing = restores.data?.entries ?? [];
  useRestoredToasts(restores.data, list);

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
        <span className="crumb-title">{t("projectsScreen.brand")}</span>
        <span className="crumb-sep">/</span>
        <span className="crumb-title" style={{ color: "var(--muted)" }}>
          {t("projectsScreen.crumbProjects")}
        </span>
        <Spacer />
        <button
          type="button"
          className="btn btn-icon no-drag"
          title={t("projectsScreen.settingsShortcutTitle")}
          aria-label={t("projectsScreen.settingsAria")}
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="i-gear" size={17} />
        </button>
      </header>

      <main className="sheet">
        <div className="wrap wrap-wide">
          <div className="sec-head">
            <div>
              <h1 className="sec-title">{t("projectsScreen.crumbProjects")}</h1>
              <p className="sec-lede" style={{ marginTop: 4 }}>
                {t("projectsScreen.leadParagraph")}
              </p>
            </div>
          </div>

          {restores.data && <RestoreBanner summary={restores.data} />}

          <div className="proj-grid">
            {list.map((p, i) => (
              <ProjectCard
                key={p.id}
                project={p}
                facts={facts.get(p.id)}
                boardNames={(boardQueries[i]?.data ?? []).map((b) => b.name)}
                onOpenSettings={() => setConfiguring(p.id)}
              />
            ))}
            {missing.map((entry) => (
              <RestoreCard key={entry.projectId} entry={entry} />
            ))}
            <button type="button" className="proj-new" onClick={() => setNewOpen(true)}>
              <Icon name="i-plus" size={20} />
              <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-lg)", color: "inherit" }}>{t("projectsScreen.newProject")}</span>
              <span style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--meta)" }}>{t("projectsScreen.newProjectCardDesc")}</span>
            </button>
            {offerSample && (
              <div className="proj-cell">
                <button type="button" className="proj-new proj-sample" disabled={sample.isPending} onClick={() => sample.mutate()}>
                  <Icon name="i-leaf" size={20} />
                  <span style={{ fontFamily: "var(--font-display)", fontSize: "var(--text-lg)", color: "inherit" }}>
                    {sample.isPending ? t("onboarding.sampleCreating") : t("onboarding.sampleTileTitle")}
                  </span>
                  <span style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--meta)" }}>{t("onboarding.sampleTileDesc")}</span>
                </button>
                <button
                  type="button"
                  className="btn btn-icon proj-gear proj-sample-hide"
                  title={t("onboarding.sampleTileHide")}
                  aria-label={t("onboarding.sampleTileHide")}
                  onClick={() => markSeen("sample-tile")}
                >
                  <Icon name="i-close" size={15} />
                </button>
              </div>
            )}
          </div>

          <hr className="rule" />
          <div className="sec-head">
            <div>
              <h2 className="sec-title">{t("projectsScreen.agentsTitle")}</h2>
              <p className="sec-lede" style={{ marginTop: 4 }}>
                {t("projectsScreen.agentsLede")}
              </p>
            </div>
          </div>
          <div className="grid-2">
            <div className="panel">
              <div className="row" style={{ gap: 7, marginBottom: "var(--space-3)" }}>
                <LiveDot />
                <Eyebrow>{t("projectsScreen.mcpListening")}</Eyebrow>
              </div>
              <p className="num" style={{ fontSize: 14, color: "var(--fg-2)" }}>
                {mcp.data ?? t("projectsScreen.notRunning")}
              </p>
              <p className="meta-txt dense" style={{ marginTop: "var(--space-3)" }}>
                {t("projectsScreen.mcpHint")}
              </p>
            </div>
            <div className="panel">
              <Eyebrow style={{ marginBottom: "var(--space-3)" }}>{t("projectsScreen.toolsExposed")}</Eyebrow>
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
                <li>{t("projectsScreen.lockedWritesBullet")}</li>
              </ul>
            </div>
          </div>
        </div>
      </main>

      <StatusBar />

      <NewProjectDialog open={newOpen} onOpenChange={setNewOpen} />
      <ProjectSettingsDialog
        project={list.find((p) => p.id === configuring) ?? null}
        projects={list}
        onOpenChange={(open) => !open && setConfiguring(null)}
      />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
