import { useMemo, useState } from "react";
import type { Project } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { Dialog, DialogBody, DialogFoot, DialogHead } from "~/components/ui/dialog";
import { Eyebrow, Num, Tag } from "~/components/ui/atoms";
import { agoLabel, isTicket, provenanceOf } from "~/lib/domain";
import { useBoards, useItems, useLabels, useRemoveProject, useUpdateProject, useViews } from "~/lib/queries";
import { useToast } from "~/lib/toast";

/** What the project holds, counted off its own rows so the sheet can never
 *  claim a number the workspace disagrees with. */
interface Facts {
  workstreams: number;
  scopes: number;
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
      workstreams: (boards.data ?? []).filter((b) => !b.across).length,
      scopes: (boards.data ?? []).filter((b) => b.across).length,
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

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
  onDeleted
}: {
  /** The project to configure; `null` closes the sheet. Look it up live — the
   *  delete unmounts the sheet by taking its subject away. */
  project: Project | null;
  /** Every project on this machine: the last one going says so. */
  projects: Project[];
  onOpenChange: (open: boolean) => void;
  /** Ran after the delete lands: leave the project, or render a dead route. */
  onDeleted?: (project: Project) => void;
}) {
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
      label={project ? (confirming ? `Delete ${project.name} permanently` : `Settings for ${project.name}`) : "Project settings"}
      className="sheet-board"
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
            onClose={() => onOpenChange(false)}
            onRequestDelete={() => setConfirming(true)}
          />
        ))}
    </Dialog>
  );
}

function SettingsFace({ project, onClose, onRequestDelete }: { project: Project; onClose: () => void; onRequestDelete: () => void }) {
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
    toast({ body: <>Saved <span className="num">{trimmed}</span></> });
  };

  return (
    <>
      <DialogHead title="Project settings" aside={<Tag tone="neutral">{name.trim() || project.name}</Tag>} />
      <DialogBody className="stack-4">
        <div className="field">
          <label htmlFor="psName">Project name</label>
          <input id="psName" autoFocus className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="psDesc">Description</label>
          <input
            id="psDesc"
            className="input"
            placeholder="What this workspace is for"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="grid-2">
          <div className="field">
            <label htmlFor="psPrefix">Issue key prefix</label>
            <input id="psPrefix" className="input num" readOnly value={project.keyPrefix} />
            <span className="meta-txt">
              Fixed at creation: <Num>{facts.issues}</Num> issue{facts.issues === 1 ? "" : "s"} already carry it, and the counter never rewinds.
            </span>
          </div>
          <div className="field">
            <label htmlFor="psId">Project id</label>
            <input id="psId" className="input num" readOnly value={project.id} />
            <span className="meta-txt">
              What an agent names over MCP — <Num>list_items projectId</Num>.
            </span>
          </div>
        </div>

        <div>
          <Eyebrow>What this project holds</Eyebrow>
          <p className="meta-txt dense" style={{ marginTop: 6 }}>
            <Num>{facts.workstreams}</Num> board{facts.workstreams === 1 ? "" : "s"} and <Num>{facts.scopes}</Num> cross-board scope
            {facts.scopes === 1 ? "" : "s"} · <Num>{facts.views}</Num> saved view{facts.views === 1 ? "" : "s"} · <Num>{facts.issues}</Num> issue
            {facts.issues === 1 ? "" : "s"}, <Num>{facts.open}</Num> open
            {facts.epics > 0 && <> under <Num>{facts.epics}</Num> epic{facts.epics === 1 ? "" : "s"}</>} · <Num>{facts.labels}</Num> label
            {facts.labels === 1 ? "" : "s"}
            {facts.lastWrite && <> · last write <Num>{agoLabel(facts.lastWrite)}</Num></>}
          </p>
          <p className="meta-txt dense" style={{ marginTop: 6 }}>
            A board's name, glyph and views are configured on the board itself. This sheet answers only for the container they sit in.
          </p>
        </div>

        <div>
          <Eyebrow>Archive</Eyebrow>
          <div className="cfg-row" style={{ marginTop: "var(--space-2)" }}>
            <Icon name={archived ? "i-archive" : "i-stack"} size={15} style={{ color: archived ? "var(--meta)" : "var(--accent)" }} />
            <span className="cfg-name">{archived ? "Archived" : "Active"}</span>
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={archived}
              aria-label="Archive this project"
              onClick={() => setArchived((v) => !v)}
            />
          </div>
          <p className="meta-txt dense" style={{ marginTop: "var(--space-2)" }}>
            Archiving marks the project in the switcher and on the projects grid. It locks nothing — boards, issues and agents over MCP carry on
            exactly as before.
          </p>
        </div>

        <div>
          <Eyebrow style={{ color: "var(--danger)" }}>Delete this project</Eyebrow>
          <p className="meta-txt dense" style={{ margin: "6px 0 var(--space-3)" }}>
            Takes every board, view and issue inside it, and their whole history with them. <Num>⌘Z</Num> cannot reach it.
          </p>
          {/* The name is not in the label: a project name has no length limit,
              and the confirmation names it twice over. */}
          <button type="button" className="btn btn-danger del-proj" aria-haspopup="dialog" onClick={onRequestDelete}>
            <Icon name="i-trash" size={13} />
            Delete project
          </button>
        </div>
      </DialogBody>
      <DialogFoot>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-secondary" onClick={save}>
          Save project
        </button>
      </DialogFoot>
    </>
  );
}

/** The plain-English list of what goes with the project. */
function consequences(project: Project, facts: Facts, last: boolean): string[] {
  const out = [
    `${plural(facts.workstreams, "board")} and ${plural(facts.scopes, "cross-board scope")}, with the ${plural(facts.views, "saved view")} on them`,
    `${plural(facts.issues, "issue")}${facts.epics ? ` and ${plural(facts.epics, "epic")}` : ""}${facts.open ? `, ${facts.open} still open` : ""}`,
    "every oplog row those issues ever wrote — the activity trail undo reads from",
    `the ${plural(facts.labels, "label")} defined here, and each issue's place in every saved view's manual order`
  ];
  const provenance = [
    facts.aiWrites && `${plural(facts.aiWrites, "issue")} last written by an agent`,
    facts.locked && `${facts.locked} locked against agent writes`
  ].filter(Boolean);
  if (provenance.length) out.push(`${provenance.join(", ")} — agents are not asked either`);
  out.push(`the key prefix ${project.keyPrefix} and its counter, so nothing is ever handed those keys again`);
  if (last) out.push("the last project on this machine — Tomrade seeds a fresh, empty one the next time it opens");
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
  const remove = useRemoveProject();
  const toast = useToast();
  const facts = useFacts(project.id);
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === project.name.trim();
  const lost = consequences(project, facts, last);

  const destroy = () => {
    if (!matches || remove.isPending) return;
    remove.mutate(project.id, {
      // No `onUndo` here, ever. A toast that offers an undo the write path
      // cannot honour is worse than no toast at all.
      onSuccess: () => {
        onDeleted();
        toast({ body: <>Permanently deleted <span className="num">{project.name}</span> and everything in it</> });
      },
      onError: (err) => toast({ body: err.message })
    });
  };

  return (
    <>
      <DialogHead title="Delete project" aside={<Tag tone="neutral">{project.keyPrefix}</Tag>} />
      <DialogBody className="stack-4">
        <p className="dlg-sub">{project.name}</p>

        <div className="dangerbar">
          <Icon className="b-mark" name="i-warn" size={15} />
          <p style={{ fontSize: 14, lineHeight: "var(--leading-dense)", color: "var(--fg-2)" }}>
            This is <strong>not undoable</strong>. A project is not in the oplog, and this takes the history of everything inside it — no snapshot is
            left for <span className="num">⌘Z</span> to restore from, and not even a tombstone naming what was here.
          </p>
        </div>

        <div>
          <p className="meta-txt dense">Deleting <Num>{project.name}</Num> takes:</p>
          <ul className="del-list">
            {lost.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>

        <div className="field">
          <label htmlFor="dpName">
            Type <span className="num">{project.name}</span> to confirm
          </label>
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
          <span className="meta-txt">The database file is untouched, and every other project in it carries on.</span>
        </div>
      </DialogBody>
      <DialogFoot>
        {/* Focus opens on the confirmation field, never on the button that
            destroys — and Enter there does nothing until the name matches. */}
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-danger" disabled={!matches || remove.isPending} onClick={destroy}>
          <Icon name="i-trash" size={13} />
          {remove.isPending ? "Deleting…" : "Delete forever"}
        </button>
      </DialogFoot>
    </>
  );
}
