import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Project } from "@tomrade/domain";
import { Icon, type IconId } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Num, SectionHead, Tag } from "~/components/ui/atoms";
import { agoLabel, isTicket, provenanceOf } from "~/lib/domain";
import { confirmationMatches } from "~/lib/confirmation";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useBoards, useItems, useLabels, useRemoveProject, useStorageInfo, useUpdateProject, useViews } from "~/lib/queries";
import { FilesBlock } from "~/components/files/FilesBlock";
import { RepositoriesBlock } from "./RepositoriesBlock";
import { StorageBlock } from "./StorageBlock";
import { useToast } from "~/lib/toast";

type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

/** What the project holds, counted off its own rows so the sheet can never
 *  claim a number the workspace disagrees with. */
interface Facts {
  workstreams: number;
  views: number;
  issues: number;
  open: number;
  epics: number;
  aiWrites: number;
  locked: number;
  labels: number;
  lastWrite: number | null;
}

/** The same query keys the workspace uses, so opening this sheet over a project
 *  already on screen costs nothing. */
function useFacts(projectId: string): Facts {
  const boards = useBoards(projectId);
  const views = useViews(projectId);
  const items = useItems(projectId);
  const labels = useLabels(projectId);
  return useMemo(() => {
    const all = items.data ?? [];
    const tickets = all.filter(isTicket);
    return {
      workstreams: (boards.data ?? []).length,
      views: (views.data ?? []).length,
      issues: tickets.length,
      open: tickets.filter((i) => i.status !== "done" && i.status !== "cancelled").length,
      epics: all.length - tickets.length,
      aiWrites: tickets.filter((i) => provenanceOf(i) === "ai").length,
      locked: tickets.filter((i) => provenanceOf(i) === "locked").length,
      labels: (labels.data ?? []).length,
      lastWrite: all.length ? Math.max(...all.map((i) => i.updatedAt)) : null
    };
  }, [boards.data, views.data, items.data, labels.data]);
}

const countPhrase = (t: T, n: number, oneKey: MessageKey, manyKey: MessageKey) => t(n === 1 ? oneKey : manyKey, { n });

/**
 * A project is the container, not the work: human-managed, outside the oplog,
 * and the one entity undo does not reach. So this sheet edits the fields a human
 * owns, states what the container holds, and keeps the delete behind a second
 * face that asks for the name in writing.
 *
 * One Dialog, two faces — one focus trap, one scrim, and Escape on the
 * confirmation lands back on the settings rather than out of the sheet.
 */
export function ProjectSettingsDialog({
  project,
  projects,
  onOpenChange,
  onDeleted,
  section
}: {
  /** The project to configure; `null` closes the sheet. Look it up live — the
   *  delete unmounts the sheet by taking its subject away. */
  project: Project | null;
  /** Every project on this machine: the last one going says so. */
  projects: Project[];
  onOpenChange: (open: boolean) => void;
  /** Ran after the delete lands: leave the project, or render a dead route. */
  onDeleted?: (project: Project) => void;
  /** Opens scrolled to one block — the assistant sends you to Repositories when a workstream has no checkout here. */
  section?: ProjectSettingsPane;
}) {
  const { t } = useI18n();
  const [confirming, setConfirming] = useState(false);

  // `open`, not a `null` return: the shared Dialog hands focus back to whatever
  // opened it on the open -> false transition, and a sheet that closes by
  // unmounting never gives it one.
  return (
    <Dialog
      open={!!project}
      // On the confirmation face, Escape and the close button step back rather
      // than out: nothing destructive is one keystroke away, and nothing is lost
      // by asking again.
      onOpenChange={(open) => {
        if (!open && confirming) return setConfirming(false);
        setConfirming(false);
        onOpenChange(open);
      }}
      label={
        project
          ? confirming
            ? t("projectSettingsDialog.dialogLabelDelete", { name: project.name })
            : t("projectSettingsDialog.dialogLabelSettings", { name: project.name })
          : t("projectSettingsDialog.dialogLabelFallback")
      }
      className="sheet-project-settings"
    >
      {project &&
        (confirming ? (
          <DeleteFace
            key={project.id}
            project={project}
            last={projects.length <= 1}
            onCancel={() => setConfirming(false)}
            onDeleted={() => {
              setConfirming(false);
              onOpenChange(false);
              onDeleted?.(project);
            }}
          />
        ) : (
          <SettingsFace
            key={project.id}
            project={project}
            section={section}
            onClose={() => onOpenChange(false)}
            onRequestDelete={() => setConfirming(true)}
          />
        ))}
    </Dialog>
  );
}

type ProjectSettingsPane = "overview" | "storage" | "repositories" | "files" | "lifecycle";

interface ProjectPane {
  id: ProjectSettingsPane;
  label: string;
  icon: IconId;
  render: () => ReactNode;
}

function SettingsFace({ project, onClose, onRequestDelete, section }: { project: Project; onClose: () => void; onRequestDelete: () => void; section?: ProjectSettingsPane }) {
  const { t, tx } = useI18n();
  const [active, setActive] = useState<ProjectSettingsPane>(section ?? "overview");
  const update = useUpdateProject();
  const toast = useToast();
  const facts = useFacts(project.id);
  /* A draft: Save writes it, Cancel discards it. */
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [archived, setArchived] = useState(project.archived);

  const save = () => {
    const trimmed = name.trim() || project.name;
    update.mutate({ id: project.id, patch: { name: trimmed, description: description.trim() || null, archived } });
    onClose();
    toast({ body: <>{tx("projectSettingsDialog.savedToast", { name: <span className="num">{trimmed}</span> })}</> });
  };

  useEffect(() => {
    if (section) setActive(section);
  }, [section]);

  const panes: ProjectPane[] = [
    {
      id: "overview",
      label: t("projectSettingsDialog.overviewLabel"),
      icon: "i-panel",
      render: () => (
        <>
          <SectionHead title={t("projectSettingsDialog.overviewLabel")}>
            {t("projectSettingsDialog.overviewLede")}
          </SectionHead>
          <div className="project-settings-fields">
            <div className="field">
              <label htmlFor="psName">{t("projectSettingsDialog.projectNameLabel")}</label>
              <input id="psName" autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="psDesc">{t("projectSettingsDialog.descriptionLabel")}</label>
              <input id="psDesc" className="input" placeholder={t("projectSettingsDialog.descriptionPlaceholder")} value={description} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div className="grid-2">
              <div className="field">
                <label htmlFor="psPrefix">{t("projectSettingsDialog.issueKeyPrefixLabel")}</label>
                <input id="psPrefix" className="input num" readOnly value={project.keyPrefix} />
                <span className="meta-txt">{t(facts.issues === 1 ? "projectSettingsDialog.keyPrefixNoteOne" : "projectSettingsDialog.keyPrefixNoteMany", { n: facts.issues })}</span>
              </div>
              <div className="field">
                <label htmlFor="psId">{t("projectSettingsDialog.projectIdLabel")}</label>
                <input id="psId" className="input num" readOnly value={project.id} />
                <span className="meta-txt">{tx("projectSettingsDialog.projectIdNote", { cmd: <Num>list_items projectId</Num> })}</span>
              </div>
            </div>
          </div>
          <div className="project-settings-section project-settings-facts">
            <Eyebrow>{t("projectSettingsDialog.whatProjectHolds")}</Eyebrow>
            <p className="meta-txt dense">
              {tx("projectSettingsDialog.holdsSummary", {
                workstreams: <Num>{facts.workstreams}</Num>, views: <Num>{facts.views}</Num>, issues: <Num>{facts.issues}</Num>, open: <Num>{facts.open}</Num>,
                epicsClause: facts.epics > 0 ? tx("projectSettingsDialog.epicsClause", { n: <Num>{facts.epics}</Num> }) : "",
                labels: <Num>{facts.labels}</Num>, lastWriteClause: facts.lastWrite ? tx("projectSettingsDialog.lastWriteClause", { when: <Num>{agoLabel(facts.lastWrite)}</Num> }) : ""
              })}
            </p>
            <p className="meta-txt dense">{t("projectSettingsDialog.boardNote")}</p>
          </div>
        </>
      )
    },
    {
      id: "storage",
      label: t("projectSettingsDialog.storageLabel"),
      icon: "i-folder",
      render: () => <><SectionHead title={t("projectSettingsDialog.storageLabel")}>{t("projectSettingsDialog.storageLede")}</SectionHead><StorageBlock projectId={project.id} /></>
    },
    {
      id: "repositories",
      label: t("projectSettingsDialog.repositoriesLabel"),
      icon: "i-branch",
      render: () => <><SectionHead title={t("projectSettingsDialog.repositoriesLabel")}>{t("projectSettingsDialog.repositoriesLede")}</SectionHead><RepositoriesBlock projectId={project.id} /></>
    },
    {
      id: "files",
      label: t("projectSettingsDialog.filesLabel"),
      icon: "i-folder",
      render: () => <><SectionHead title={t("projectSettingsDialog.filesLabel")}>{t("projectSettingsDialog.filesLede")}</SectionHead><FilesBlock projectId={project.id} /></>
    },
    {
      id: "lifecycle",
      label: t("projectSettingsDialog.lifecycleLabel"),
      icon: "i-archive",
      render: () => (
        <>
          <SectionHead title={t("projectSettingsDialog.lifecycleLabel")}>{t("projectSettingsDialog.lifecycleLede")}</SectionHead>
          <div className="project-settings-section project-settings-copy">
            <Eyebrow>{t("projectSettingsDialog.archiveLabel")}</Eyebrow>
            <div className="cfg-row">
              <Icon name={archived ? "i-archive" : "i-stack"} size={15} style={{ color: archived ? "var(--meta)" : "var(--accent)" }} />
              <span className="cfg-name">{archived ? t("projectSettingsDialog.archived") : t("projectSettingsDialog.active")}</span>
              <button type="button" className="switch" role="switch" aria-checked={archived} aria-label={t("projectSettingsDialog.archiveAria")} onClick={() => setArchived((v) => !v)} />
            </div>
            <p className="meta-txt dense">{t("projectSettingsDialog.archiveNote")}</p>
          </div>
          <div className="project-settings-section project-settings-copy">
            <Eyebrow style={{ color: "var(--danger)" }}>{t("projectSettingsDialog.deleteThisProject")}</Eyebrow>
            <p className="meta-txt dense">{tx("projectSettingsDialog.deleteWarning", { cmdz: <Num>⌘Z</Num> })}</p>
            <button type="button" className="btn btn-danger del-proj" aria-haspopup="dialog" onClick={onRequestDelete}><Icon name="i-trash" size={13} />{t("projectSettingsDialog.deleteButton")}</button>
          </div>
        </>
      )
    }
  ];
  const current = panes.find((pane) => pane.id === active) ?? panes[0];

  return (
    <>
      <DialogHead title={t("projectSettingsDialog.headTitle")} aside={<Tag tone="neutral">{name.trim() || project.name}</Tag>} />
      <div className="dlg-split project-settings-split">
        <nav className="dlg-nav" aria-label={t("projectSettingsDialog.navAriaLabel")}>
          <div className="side-group">
            <Eyebrow className="side-label">{t("projectSettingsDialog.groupProject")}</Eyebrow>
            {panes.map((pane) => <button key={pane.id} type="button" className="side-row" aria-current={pane.id === current.id} onClick={() => setActive(pane.id)}><Icon className="ico" name={pane.icon} size={14} /><span className="side-name">{pane.label}</span></button>)}
          </div>
        </nav>
        <DialogBody className="project-settings-body">{current.render()}</DialogBody>
      </div>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          {t("projectSettingsDialog.cancel")}
        </button>
        <button type="button" className="btn btn-secondary" onClick={save}>
          {t("projectSettingsDialog.saveProject")}
        </button>
      </DialogFoot>
    </>
  );
}

/** The plain-English list of what goes with the project. */
function consequences(project: Project, facts: Facts, last: boolean, published: boolean, deleteFolder: boolean, t: T): string[] {
  const out = [
    t("projectSettingsDialog.consequenceWorkstreamsViews", {
      boards: countPhrase(t, facts.workstreams, "projectSettingsDialog.boardOne", "projectSettingsDialog.boardMany"),
      views: countPhrase(t, facts.views, "projectSettingsDialog.viewOne", "projectSettingsDialog.viewMany")
    }),
    t("projectSettingsDialog.consequenceIssues", {
      issues: countPhrase(t, facts.issues, "projectSettingsDialog.issueOne", "projectSettingsDialog.issueMany"),
      epicsClause: facts.epics
        ? t("projectSettingsDialog.consequenceIssuesEpicsClause", { epics: countPhrase(t, facts.epics, "projectSettingsDialog.epicOne", "projectSettingsDialog.epicMany") })
        : "",
      openClause: facts.open ? t("projectSettingsDialog.consequenceIssuesOpenClause", { n: facts.open }) : ""
    }),
    t("projectSettingsDialog.consequenceOplog"),
    t("projectSettingsDialog.consequenceLabels", { labels: countPhrase(t, facts.labels, "projectSettingsDialog.labelOne", "projectSettingsDialog.labelMany") })
  ];
  const provenance = [
    facts.aiWrites && t("projectSettingsDialog.consequenceAiWrites", { issues: countPhrase(t, facts.aiWrites, "projectSettingsDialog.issueOne", "projectSettingsDialog.issueMany") }),
    facts.locked && t("projectSettingsDialog.consequenceLocked", { n: facts.locked })
  ].filter(Boolean);
  if (provenance.length) out.push(t("projectSettingsDialog.consequenceProvenanceJoin", { list: provenance.join(", ") }));
  out.push(t("projectSettingsDialog.consequenceKeyPrefix", { prefix: project.keyPrefix }));
  out.push(t(deleteFolder ? "projectSettingsDialog.consequenceFolderDeleted" : "projectSettingsDialog.consequenceFolderKept"));
  if (published) out.push(t("projectSettingsDialog.consequencePublished"));
  if (last) out.push(t("projectSettingsDialog.consequenceLastProject", { brand: "Tomrade" }));
  return out;
}

/**
 * The second irreversible write in the app, and the larger one — so it asks for
 * the name in writing rather than for a single click.
 *
 * A project is not in the oplog at all: unlike a purged issue there is no
 * snapshot, no tombstone, and nothing for `⌘Z` to walk back to. Cancel holds the
 * focus, and the button that destroys stays disabled until the name matches.
 */
function DeleteFace({
  project,
  last,
  onCancel,
  onDeleted
}: {
  project: Project;
  last: boolean;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const { t, tx } = useI18n();
  const remove = useRemoveProject();
  const toast = useToast();
  const facts = useFacts(project.id);
  const [typed, setTyped] = useState("");
  /** Off by default: forgetting a project on this machine is reversible; deleting its folder is not. */
  const [deleteFolder, setDeleteFolder] = useState(false);
  const matches = confirmationMatches(typed, project.name);
  const info = useStorageInfo(project.id);
  const published = !!info.data?.remote;
  const lost = consequences(project, facts, last, published, deleteFolder, t);

  const destroy = () => {
    if (!matches || remove.isPending) return;
    remove.mutate({ id: project.id, deleteFolder }, {
      // No `onUndo` here, ever. A toast that offers an undo the write path
      // cannot honour is worse than no toast at all.
      onSuccess: () => {
        onDeleted();
        toast({ body: <>{tx("projectSettingsDialog.deletedToast", { name: <span className="num">{project.name}</span> })}</> });
      },
      onError: (err) => toast({ body: err.message })
    });
  };

  return (
    <>
      <DialogHead title={t("projectSettingsDialog.deleteHeadTitle")} aside={<Tag tone="neutral">{project.keyPrefix}</Tag>} />
      <DialogBody className="stack-4">
        <p className="dlg-sub">{project.name}</p>

        <div className="dangerbar">
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
            {tx("projectSettingsDialog.notUndoable", {
              strong: <strong>{t("projectSettingsDialog.notUndoableStrong")}</strong>,
              cmdz: <span className="num">⌘Z</span>
            })}
          </p>
        </div>

        <div>
          <p className="meta-txt dense">{tx("projectSettingsDialog.takesLabel", { name: <Num>{project.name}</Num> })}</p>
          <ul className="del-list">
            {lost.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        {info.data?.dir && (
          <label className="cfg-row del-folder" style={{ cursor: "pointer" }}>
            <input type="checkbox" checked={deleteFolder} onChange={(e) => setDeleteFolder(e.target.checked)} />
            <span className="cfg-name">{t("projectSettingsDialog.alsoDeleteFolder")}</span>
            <span className="meta-txt num" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 260 }} title={info.data.dir}>
              {info.data.dir}
            </span>
          </label>
        )}

        <div className="field">
          <label htmlFor="dpName">{tx("projectSettingsDialog.typeToConfirmLabel", { name: <span className="num">{project.name}</span> })}</label>
          <input
            id="dpName"
            autoFocus
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") destroy();
            }}
          />
          <span className="meta-txt">
            {deleteFolder ? t("projectSettingsDialog.folderDeletedNote") : published ? t("projectSettingsDialog.publishedNote") : t("projectSettingsDialog.notPublishedNote")}
          </span>
        </div>
      </DialogBody>
      <DialogFoot>
        {/* Focus opens on the confirmation field, never on the button that
            destroys — and Enter there does nothing until the name matches. */}
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          {t("projectSettingsDialog.cancel")}
        </button>
        <button type="button" className="btn btn-danger" disabled={!matches || remove.isPending} onClick={destroy}>
          <Icon name="i-trash" size={13} />
          {remove.isPending ? t("projectSettingsDialog.deleting") : t("projectSettingsDialog.deleteForever")}
        </button>
      </DialogFoot>
    </>
  );
}
