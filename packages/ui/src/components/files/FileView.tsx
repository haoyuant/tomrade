import { useEffect, useMemo, useRef, useState } from "react";
import { isNotePath } from "@tomradex/notes/syntax";
import type { ConflictChoice, FileConflict, FileContent } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Eyebrow, Spacer } from "~/components/ui/atoms";
import { agoLabel } from "~/lib/domain";
import { nameOf, useFileContent, useFileHistory, useFileVersion, useResolveConflict } from "~/lib/files";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { errorSpec, useToast } from "~/lib/toast";
import { takeEditRequest, useFileMode, useNoteTags, useNotesEnabled, type FileMode } from "~/lib/notes";
import { Backlinks } from "./Backlinks";
import { ConflictPanel } from "./ConflictPanel";
import { FileViewer, isRenderable } from "./FileViewer";
import { NoteEditor, type SaveState } from "./NoteEditor";
import { useNoteActions } from "./useNoteActions";
import { hits, keyLabel } from "~/lib/keybindings";

const SAVE_LABEL: Record<SaveState, MessageKey> = { saved: "notes.saved", dirty: "notes.unsaved", saving: "notes.saving" };

export function FileView({ projectId, path, conflict }: { projectId: string; path: string; conflict: FileConflict | null }) {
  const { t } = useI18n();
  const toast = useToast();
  const content = useFileContent(projectId, path);
  const history = useFileHistory(projectId, path);
  const resolve = useResolveConflict(projectId);
  const notesOn = useNotesEnabled();
  const actions = useNoteActions();
  const linking = useMemo(() => actions.linking(path), [actions, path]);
  const [preferred, setPreferred, writing] = useFileMode();
  // A note just made, or a link just followed into nothing, opens to be written in — the way writing was last done.
  const [requested, setRequested] = useState(() => takeEditRequest(path));
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [versionId, setVersionId] = useState<string | null>(null);
  const fileId = content.data?.fileId ?? null;
  const older = useFileVersion(projectId, versionId && fileId ? { fileId, versionId } : null);
  const versions = history.data ?? [];
  // The rail's own newest row, so a click compares against what is drawn, not a content fetch still in flight.
  const latest = versions[0]?.versionId ?? content.data?.versionId ?? null;
  const shown = versionId ? (older.data ?? null) : (content.data ?? null);
  const editable = !versionId && !conflict && !!content.data && content.data.encoding === "utf8" && !content.data.truncated;
  const wanted: FileMode = requested && preferred === "read" ? writing : preferred;
  // Unsaved edits hold the editor open through a delete, a move or a sync clash, so its own save can ask what to do.
  const held = useRef<FileContent | null>(null);
  const holding = wanted !== "read" && !editable && saveState !== "saved" && held.current !== null;
  const writes = (editable && wanted !== "read") || holding;
  if (writes && editable) held.current = content.data!;
  else if (!writes) held.current = null;
  const editorContent = editable ? content.data! : held.current;
  // Side by side only where the file renders as something other than its text.
  const previewable = !!editorContent && isRenderable(editorContent);
  const mode: FileMode = !writes ? "read" : wanted === "split" && previewable ? "split" : "edit";
  const tags = useNoteTags(projectId, notesOn && mode !== "read");
  const setMode = (next: FileMode) => {
    setRequested(false);
    setPreferred(next);
  };
  const backlinks = notesOn && !versionId && isNotePath(path) && content.data ? <Backlinks projectId={projectId} path={path} paths={actions.paths} /> : null;
  useEffect(() => {
    if (!editable) return;
    // On a Mac, Ctrl-E is the end of the line in any text field; only ⌘E is ours — so no Ctrl leniency here.
    const onKey = (e: KeyboardEvent) => {
      // Not behind a dialog, and not from some other field: the editor itself is fine.
      const field = /^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement as HTMLElement | null)?.tagName ?? "");
      if (e.defaultPrevented || field || document.documentElement.classList.contains("overlay-open")) return;
      if (hits(e, "readWrite")) {
        e.preventDefault();
        setMode(mode === "read" ? writing : "read");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const choose = (choice: ConflictChoice) =>
    resolve.mutate(
      { path, choice },
      {
        onSuccess: () => toast({ body: t("files.resolvedToast", { choice: t(choice === "ours" ? "files.sideMine" : choice === "theirs" ? "files.sideTheirs" : "files.sideBoth"), name: nameOf(path) }) }),
        onError: (error) => toast(errorSpec(error))
      }
    );
  return (
    <>
      <div className={`files-main${mode === "split" ? " is-split" : ""}`}>
        {conflict && !holding ? (
          <ConflictPanel conflict={conflict} busy={resolve.isPending} onChoose={choose} />
        ) : (
          <>
            {versionId && (
              <div className="banner files-version-banner" role="status">
                <Icon className="b-mark" name="i-clock" size={15} />
                <span>{t("files.olderVersion", { when: agoLabel(versions.find((v) => v.versionId === versionId)?.at ?? Date.now()) })}</span>
                <button type="button" className="btn btn-ghost" style={{ marginLeft: "auto", padding: "3px 8px" }} onClick={() => setVersionId(null)}>
                  {t("files.backToLatest")}
                </button>
              </div>
            )}
            {(editable || holding) && (
              <div className="row file-view-bar files-mode-bar">
                <div className="seg quiet files-mode" role="group" aria-label={t("notes.modeAria")} data-mode={mode}>
                  <button type="button" aria-pressed={mode === "read"} data-tip={keyLabel("readWrite")} onClick={() => setMode("read")}>
                    <Icon className="ico" name="i-eye" size={13} />
                    {t("notes.read")}
                  </button>
                  <button type="button" aria-pressed={mode === "edit"} data-tip={writing === "edit" || !previewable ? keyLabel("readWrite") : undefined} onClick={() => setMode("edit")}>
                    <Icon className="ico" name="i-pen" size={13} />
                    {t("notes.edit")}
                  </button>
                  {previewable && (
                    <button type="button" aria-pressed={mode === "split"} data-tip={writing === "split" ? keyLabel("readWrite") : undefined} onClick={() => setMode("split")}>
                      <Icon className="ico" name="i-split" size={13} />
                      {t("notes.split")}
                    </button>
                  )}
                </div>
                <Spacer />
                {mode !== "read" && (
                  <span className="meta-txt files-save-state" data-state={saveState}>
                    {t(SAVE_LABEL[saveState])}
                  </span>
                )}
              </div>
            )}
            {content.isLoading || (versionId && older.isLoading) ? null : mode !== "read" && editorContent ? (
              <NoteEditor
                key={path}
                projectId={projectId}
                content={editorContent}
                paths={actions.paths}
                tags={(tags.data ?? []).map((tag) => tag.tag)}
                resolve={linking.resolve}
                onOpenLink={linking.open}
                onState={setSaveState}
                autoFocus={requested || preferred !== "read"}
                preview={
                  mode === "split"
                    ? (text) => (
                        <>
                          <FileViewer content={{ ...editorContent, body: text }} linking={linking} switch={false} lines />
                          {backlinks}
                        </>
                      )
                    : undefined
                }
              />
            ) : shown ? (
              <FileViewer content={shown} linking={linking} switch={!editable} />
            ) : (
              <p className="meta-txt">{t("files.fileGone", { path })}</p>
            )}
            {mode !== "split" && backlinks}
          </>
        )}
      </div>
      <aside className="files-rail" aria-label={t("files.versions")} data-testid="files-versions">
        <Eyebrow>{t("files.versions")}</Eyebrow>
        {versions.length === 0 && !history.isLoading && <p className="meta-txt dense">{t("files.noVersions")}</p>}
        <div className="version-list">
          {versions.map((v) => (
            <button key={v.versionId} type="button" className="version-row" data-version={v.versionId} aria-current={v.versionId === (versionId ?? latest)} onClick={() => setVersionId(v.versionId === latest ? null : v.versionId)}>
              <span className="v-msg">{v.message}</span>
              <span className="meta-txt">
                {agoLabel(v.at)} · {v.author}
              </span>
            </button>
          ))}
        </div>
      </aside>
    </>
  );
}
