import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { EditorState, Prec, type Text } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { syntaxHighlighting } from "@codemirror/language";
import { FILE_LINK } from "@tomradex/domain";
import type { FileContent } from "@tomradex/files";
import { Icon } from "~/components/icons";
import { Spacer } from "~/components/ui/atoms";
import { invoke } from "~/lib/api";
import { editorTheme, markdownHighlight } from "~/lib/editorStyle";
import { filesKeys } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { renderMarkdown } from "~/lib/markdown";
import { openExternal } from "~/lib/shell";
import { errorSpec, readableError, useToast } from "~/lib/toast";
import { cn } from "~/lib/utils";
import type { FieldProps } from "./fields";
import { hits } from "~/lib/keybindings";

/** The Files store's binary read limit: anything larger could be saved but never shown again. */
const ATTACHMENT_LIMIT = 8 * 1024 * 1024;
const DRAFT_LINK = "tomrade-draft://";

/** A pasted or dropped file, held in memory until the body is saved — a discarded edit leaves nothing in Files. */
interface Draft {
  id: string;
  name: string;
  mime: string;
  base64: string;
  src: string;
}

/** An edit that could not land as its editor went away, picked up when the ticket's body is opened again. */
interface Stash {
  text: string;
  base: string;
  drafts: Draft[];
  uploaded: [string, string][];
}

const stashes = new Map<string, Stash>();
const stashKey = (projectId: string, itemId: string) => `${projectId}:${itemId}`;

/**
 * The same edit kept on disk as it is typed, so a reload, a quit or a crash
 * leaves it to be picked up. Attachments too big for storage stay behind; the
 * text never does.
 */
const STORED = "tomrade.bodyDraft.";
const stored = {
  read(key: string): Stash | undefined {
    try {
      const raw = localStorage.getItem(STORED + key);
      return raw ? (JSON.parse(raw) as Stash) : undefined;
    } catch {
      return undefined;
    }
  },
  write(key: string, stash: Stash): void {
    try {
      localStorage.setItem(STORED + key, JSON.stringify(stash));
    } catch {
      try {
        localStorage.setItem(STORED + key, JSON.stringify({ ...stash, drafts: [] }));
      } catch {
        // storage refused even the text; the in-memory stash still covers a reopen
      }
    }
  },
  clear(key: string): void {
    try {
      localStorage.removeItem(STORED + key);
    } catch {
      // nothing to clear when storage is unavailable
    }
  }
};

const srcOf = (content: FileContent | null | undefined): string | null | undefined => {
  if (content === undefined) return undefined;
  if (!content || content.truncated || !content.mime.startsWith("image/")) return null;
  return content.encoding === "base64" ? `data:${content.mime};base64,${content.body}` : `data:${content.mime};charset=utf-8,${encodeURIComponent(content.body)}`;
};

const readDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });

const label = (name: string) => name.replace(/[\\[\]]/g, "\\$&");

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "application/pdf": "pdf" };

/** Files reads a type from the name, so a pasted image that came without one gets the extension its type implies. */
const nameOf = (file: File, fallback: string): string => {
  const name = file.name || fallback;
  const ext = EXTENSIONS[file.type];
  return ext && !/\.[a-z0-9]+$/i.test(name) ? `${name}.${ext}` : name;
};

/**
 * The description as Markdown: read as rendered text, edited as source with a
 * preview a click away. Files pasted, dropped or added while editing are held
 * here and written to Files only when the body is saved, so an abandoned edit
 * leaves no file behind.
 */
export function IssueBody({ item, write, className }: FieldProps & { className: string }) {
  const [editing, setEditing] = useState(() => stashes.has(stashKey(item.projectId, item.id)) || !!stored.read(stashKey(item.projectId, item.id)));
  return editing ? (
    <BodyEditor item={item} write={write} className={className} onDone={() => setEditing(false)} />
  ) : (
    <BodyRead projectId={item.projectId} body={item.body ?? ""} className={className} onEdit={() => setEditing(true)} />
  );
}

function BodyRead({ projectId, body, className, onEdit }: { projectId: string; body: string; className: string; onEdit: () => void }) {
  const { t } = useI18n();
  if (!body.trim()) {
    return (
      <button type="button" className={cn("inline-edit", className)} data-testid="issue-body" title={t("fields.clickToEdit")} onClick={onEdit}>
        <span className="inline-hint">{t("fields.noDescriptionPlaceholder")}</span>
      </button>
    );
  }
  return (
    <div
      className={cn("body-read", className)}
      data-testid="issue-body"
      tabIndex={0}
      role="group"
      aria-label={t("fields.issueDescriptionAria")}
      title={t("fields.clickToEdit")}
      onClick={() => {
        // selecting text to copy it is not asking to edit it
        if (!window.getSelection()?.toString()) onEdit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.target === e.currentTarget) {
          e.preventDefault();
          onEdit();
        }
      }}
    >
      <BodyMarkdown projectId={projectId} text={body} />
    </div>
  );
}

/** Rendered body text: store files drawn from Files by id, drafts from memory, links that open rather than edit. */
function BodyMarkdown({ projectId, text, drafts }: { projectId: string; text: string; drafts?: ReadonlyMap<string, Draft> }) {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const base = useMemo(() => renderMarkdown(text, undefined, { notes: false, breaks: true }), [text]);
  const imageIds = useMemo(() => [...new Set([...base.matchAll(/<img class="md-file" data-file-id="([^"]+)"/g)].map((m) => m[1]!))], [base]);
  const images = useQueries({
    queries: imageIds.map((id) => ({ queryKey: filesKeys.byId(projectId, id), queryFn: () => invoke("files.readById", projectId, id), retry: false, staleTime: 60_000 }))
  });
  const sources = images.map((q) => (q.isError ? null : srcOf(q.data)));
  const loaded = images.map((q) => `${q.status}:${q.dataUpdatedAt}`).join("|");
  const html = useMemo(() => {
    if (!base.includes('class="md-file"')) return base;
    const tpl = document.createElement("template");
    tpl.innerHTML = base;
    for (const img of tpl.content.querySelectorAll<HTMLImageElement>("img.md-file")) {
      const src = img.dataset.draftId ? (drafts?.get(img.dataset.draftId)?.src ?? null) : sources[imageIds.indexOf(img.dataset.fileId!)];
      if (src) img.src = src;
      else if (src === null) {
        // a body synced ahead of its files reads as waiting, not broken
        const missing = document.createElement("span");
        missing.className = "md-file-missing";
        missing.textContent = t("fields.attachMissing", { name: img.alt || t("fields.attachUnnamed") });
        img.replaceWith(missing);
      }
    }
    return tpl.innerHTML;
    // `loaded` stands for `sources`, which is a new array every render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, drafts, imageIds, loaded, t]);

  const open = (fileId: string, name: string) =>
    void invoke("files.locate", projectId, fileId)
      .then((path) => (path ? void navigate({ to: "/p/$projectId/f/$", params: { projectId, _splat: path } }) : toast({ body: t("fields.attachMissing", { name }) })))
      .catch((err: Error) => toast(errorSpec(err)));

  const onClick = (e: MouseEvent<HTMLElement>) => {
    const target = e.target as HTMLElement;
    const file = target.closest<HTMLElement>("img.md-file, a.md-attachment");
    const anchor = target.closest("a");
    if (!file && !anchor) return;
    e.preventDefault();
    if (file?.dataset.draftId) return;
    // a link is somewhere to go, not a way into the editor
    e.stopPropagation();
    if (file?.dataset.fileId) return open(file.dataset.fileId, file.getAttribute("alt") ?? file.textContent ?? "");
    const href = anchor?.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) openExternal(href);
  };

  return <article className="md-view md-body" dangerouslySetInnerHTML={{ __html: html }} onClick={onClick} />;
}

function BodyEditor({ item, write, className, onDone }: FieldProps & { className: string; onDone: () => void }) {
  const { t, tx } = useI18n();
  const toast = useToast();
  const qc = useQueryClient();
  const key = stashKey(item.projectId, item.id);
  const [restored] = useState(() => stashes.get(key) ?? stored.read(key));
  /** The body this edit started from: a body that is no longer it was changed by somebody else meanwhile. */
  const base = useRef(restored?.base ?? item.body ?? "");
  const drafts = useRef(new Map<string, Draft>(restored?.drafts.map((d) => [d.id, d])));
  /** Drafts already in Files: a save refused after its files landed retries without writing them twice. */
  const uploaded = useRef(new Map<string, string>(restored?.uploaded));
  const doc = useRef<Text | null>(null);
  const latest = useRef(item);
  latest.current = item;
  const frame = useRef<HTMLDivElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const done = useRef(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const [mode, setMode] = useState<"write" | "preview">("write");
  const [preview, setPreview] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const persistTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const changed = (item.body ?? "") !== base.current;

  const text = () => doc.current?.toString() ?? restored?.text ?? base.current;
  const linked = (body: string) => [...drafts.current.values()].filter((d) => body.includes(`${DRAFT_LINK}${d.id}`));
  const dirty = () => text().trim() !== base.current.trim();

  const snapshot = (): Stash => ({ text: text(), base: base.current, drafts: linked(text()), uploaded: [...uploaded.current] });

  const persist = () => {
    clearTimeout(persistTimer.current);
    if (done.current) return;
    if (dirty()) stored.write(key, snapshot());
    else stored.clear(key);
  };

  /** `keep` leaves the stored draft for the next open: a save that could not land is still an edit in progress. */
  const close = (keep = false) => {
    done.current = true;
    clearTimeout(persistTimer.current);
    if (!keep) stored.clear(key);
    onDone();
  };

  const stash = () => {
    stashes.set(key, snapshot());
    stored.write(key, snapshot());
    toast({ body: tx("fields.bodyStashedToast", { key: <span className="num">{latest.current.key}</span> }) });
  };

  const commit = async (opts: { force?: boolean; leaving?: boolean } = {}) => {
    if (done.current || busy.current) return;
    if (!dirty()) return close();
    if (!opts.force && (latest.current.body ?? "") !== base.current) {
      if (opts.leaving) {
        stash();
        close(true);
      }
      return;
    }
    busy.current = true;
    setSaving(true);
    try {
      let next = text();
      const pending = linked(next).filter((d) => !uploaded.current.has(d.id));
      if (pending.length) {
        const added = await invoke("files.addAttachments", latest.current.projectId, latest.current.id, pending.map((d) => ({ name: d.name, base64: d.base64 })));
        pending.forEach((d, i) => {
          const file = added[i]!;
          uploaded.current.set(d.id, file.fileId);
          // the bytes are in hand: the read view draws them without fetching back what was just written
          qc.setQueryData<FileContent>(filesKeys.byId(latest.current.projectId, file.fileId), {
            path: file.path, name: file.name, fileId: file.fileId, versionId: null, mime: file.mime, size: file.size, encoding: "base64", body: d.base64, truncated: false
          });
        });
      }
      for (const [draftId, fileId] of uploaded.current) next = next.replaceAll(`${DRAFT_LINK}${draftId}`, `${FILE_LINK}${fileId}`);
      next = next.trim();
      const ok = await write(latest.current, { body: next || null }, tx("fields.editedDescriptionToast", { key: <span className="num">{latest.current.key}</span> }));
      if (ok) close();
      else if (!mounted.current) stash();
    } catch (err) {
      toast({ body: t("fields.attachFailedToast", { error: readableError(err) }) });
      if (!mounted.current) stash();
    } finally {
      busy.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const discard = () => {
    if (done.current) return;
    close();
  };

  const addFiles = async (files: File[], at?: number) => {
    const added: Draft[] = [];
    for (const file of files) {
      if (file.size > ATTACHMENT_LIMIT) {
        toast({ body: t("fields.attachTooLargeToast", { name: file.name }) });
        continue;
      }
      try {
        const src = await readDataUrl(file);
        const draft: Draft = { id: crypto.randomUUID(), name: nameOf(file, t("fields.attachUnnamed")), mime: file.type || "application/octet-stream", base64: src.slice(src.indexOf(",") + 1), src };
        drafts.current.set(draft.id, draft);
        added.push(draft);
      } catch (err) {
        toast(errorSpec(err));
      }
    }
    const v = view.current;
    if (!v || !added.length) return;
    const snippet = added.map((d) => `${d.mime.startsWith("image/") ? "!" : ""}[${label(d.name)}](${DRAFT_LINK}${d.id})`).join("\n");
    const pos = at ?? v.state.selection.main.head;
    const line = v.state.doc.lineAt(pos);
    const insert = `${pos > line.from ? "\n" : ""}${snippet}${pos < line.to ? "\n" : ""}`;
    v.dispatch({ changes: { from: pos, insert }, selection: { anchor: pos + insert.length }, scrollIntoView: true });
    if (mode === "preview") setPreview(v.state.doc.toString());
    else v.focus();
  };
  const addRef = useRef(addFiles);
  addRef.current = addFiles;
  const commitRef = useRef(commit);
  commitRef.current = commit;
  const persistRef = useRef(persist);
  persistRef.current = persist;

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: restored?.text ?? item.body ?? "",
        extensions: [
          // ⌘↵ is the frame's to handle; the default binding would insert a line first
          Prec.highest(keymap.of([{ key: "Mod-Enter", run: () => true }])),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(markdownHighlight),
          EditorView.lineWrapping,
          placeholder(t("fields.bodyPlaceholder")),
          editorTheme,
          EditorView.contentAttributes.of({ "aria-label": t("fields.issueDescriptionAria") }),
          EditorView.updateListener.of((update) => {
            doc.current = update.state.doc;
            if (update.docChanged) {
              clearTimeout(persistTimer.current);
              persistTimer.current = setTimeout(() => persistRef.current(), 400);
            }
          }),
          EditorView.domEventHandlers({
            paste: (event) => {
              const files = [...(event.clipboardData?.files ?? [])];
              if (!files.length) return false;
              event.preventDefault();
              void addRef.current(files);
              return true;
            },
            drop: (event, editor) => {
              const files = [...(event.dataTransfer?.files ?? [])];
              if (!files.length) return false;
              event.preventDefault();
              void addRef.current(files, editor.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined);
              return true;
            }
          })
        ]
      })
    });
    doc.current = v.state.doc;
    view.current = v;
    v.dispatch({ selection: { anchor: v.state.doc.length } });
    v.focus();
    return () => {
      view.current = null;
      v.destroy();
    };
    // the editor is made once; what it reads later comes through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    mounted.current = true;
    stashes.delete(key);
    // a reload or quit gives no time to save; what is on disk then is the edit as typed
    const onUnload = () => persistRef.current();
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      mounted.current = false;
      persistRef.current();
      // StrictMode unmounts and remounts at once; only an editor that stayed gone saves on its way out
      setTimeout(() => {
        if (!mounted.current && !done.current && dirty()) void commitRef.current({ leaving: true });
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchTo = (next: "write" | "preview") => {
    if (next === "preview") setPreview(text());
    setMode(next);
    if (next === "write") requestAnimationFrame(() => view.current?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // an edit is not thrown away by one stray key: the first Escape asks, the second discards
      if (!dirty() || confirmingDiscard) discard();
      else setConfirmingDiscard(true);
    } else if (hits(e.nativeEvent, "saveBody", { lenientCtrl: true })) {
      e.preventDefault();
      void commit();
    }
  };

  return (
    <div
      ref={frame}
      className={cn("body-editor", className)}
      data-testid="issue-body-editor"
      data-mode={mode}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onBlur={() =>
        // after the tick focus lands somewhere: inside the frame, or nowhere because the window lost it
        setTimeout(() => {
          if (mounted.current && document.hasFocus() && !frame.current?.contains(document.activeElement)) void commitRef.current();
        }, 0)
      }
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      }}
      onDrop={(e) => {
        // a drop on the preview or the bar, not the text: append at the end
        if (e.defaultPrevented || !e.dataTransfer.files.length) return;
        e.preventDefault();
        void addFiles([...e.dataTransfer.files], view.current?.state.doc.length);
      }}
    >
      <div className="row body-editor-bar">
        <div className="seg quiet" role="group" aria-label={t("fields.bodyModeAria")}>
          <button type="button" aria-pressed={mode === "write"} onClick={() => switchTo("write")}>
            <Icon name="i-pen" size={13} />
            {t("fields.bodyWrite")}
          </button>
          <button type="button" aria-pressed={mode === "preview"} onClick={() => switchTo("preview")}>
            <Icon name="i-eye" size={13} />
            {t("fields.bodyPreview")}
          </button>
        </div>
        <Spacer />
        <button type="button" className="btn btn-ghost body-editor-add" onClick={() => picker.current?.click()}>
          <Icon name="i-upload" size={13} />
          {t("fields.bodyAddFile")}
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            if (files.length) void addFiles(files);
          }}
        />
      </div>
      {confirmingDiscard && (
        <div className="body-editor-changed" role="alert">
          <Icon name="i-warn" size={14} />
          <span>{t("fields.bodyDiscardConfirm")}</span>
          <Spacer />
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setConfirmingDiscard(false);
              view.current?.focus();
            }}
          >
            {t("fields.bodyKeepEditing")}
          </button>
          <button type="button" className="btn btn-ghost is-danger" onClick={discard}>
            {t("fields.bodyDiscard")}
          </button>
        </div>
      )}
      {restored && !changed && !confirmingDiscard && (
        <div className="body-editor-changed is-restored" role="status">
          <Icon name="i-info" size={14} />
          <span>{t("fields.bodyRestoredNotice")}</span>
          <Spacer />
          <button type="button" className="btn btn-ghost" onClick={discard}>
            {t("fields.bodyDiscardDraft")}
          </button>
        </div>
      )}
      {changed && !saving && (
        <div className="body-editor-changed" role="alert">
          <Icon name="i-warn" size={14} />
          <span>{t("fields.bodyChangedNotice")}</span>
          <Spacer />
          <button type="button" className="btn btn-ghost" onClick={() => void commit({ force: true })}>
            {t("fields.bodyKeepMine")}
          </button>
          <button type="button" className="btn btn-ghost" onClick={discard}>
            {t("fields.bodyTakeTheirs")}
          </button>
        </div>
      )}
      <div ref={host} className="body-editor-text" hidden={mode !== "write"} />
      {mode === "preview" &&
        (preview.trim() ? (
          <div className="body-editor-preview">
            <BodyMarkdown projectId={item.projectId} text={preview} drafts={drafts.current} />
          </div>
        ) : (
          <p className="body-editor-preview inline-hint">{t("fields.bodyPreviewEmpty")}</p>
        ))}
      <p className="meta-txt dense body-editor-foot">{saving ? t("fields.bodySaving") : t("fields.bodyHint")}</p>
    </div>
  );
}
