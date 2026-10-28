import { lazy, Suspense, useState, type Attributes, type ComponentProps, type ComponentType } from "react";
import type { IssueBody as IssueBodyNow } from "~/components/issue/IssueBody";
import type { FileViewer as FileViewerNow } from "~/components/files/FileViewer";
import type { NoteEditor as NoteEditorNow } from "~/components/files/NoteEditor";
import type { AnnouncementBody as AnnouncementBodyNow } from "~/components/dialogs/AnnouncementBody";
import type { SettingsDialog as SettingsDialogNow } from "~/components/dialogs/SettingsDialog";
import type { InboxDialog as InboxDialogNow } from "~/components/dialogs/InboxDialog";
import type { FieldsDialog as FieldsDialogNow } from "~/components/dialogs/FieldsDialog";
import type { Review as ReviewNow } from "~/components/workspace/agent-panel/Review";

/**
 * Views that bring a heavy library — CodeMirror, React Flow and dagre, the Markdown renderer — loaded the first time
 * one shows, so a window starts with what its first screen needs. Until then each holds its place with its own box.
 */
const Graph = lazy(() => import("~/components/workspace/GraphView").then((m) => ({ default: m.GraphView })));
const Body = lazy(() => import("~/components/issue/IssueBody").then((m) => ({ default: m.IssueBody })));
const Viewer = lazy(() => import("~/components/files/FileViewer").then((m) => ({ default: m.FileViewer })));
const Editor = lazy(() => import("~/components/files/NoteEditor").then((m) => ({ default: m.NoteEditor })));
const Announcement = lazy(() => import("~/components/dialogs/AnnouncementBody").then((m) => ({ default: m.AnnouncementBody })));
// The look back plays a terminal's recording: it brings xterm, which the main window otherwise never draws.
const Looking = lazy(() => import("~/components/workspace/agent-panel/Review").then((m) => ({ default: m.Review })));

/**
 * A sheet loaded the first time it opens, and kept mounted after, so it opens again as it was left (Settings on the
 * pane it showed). Until then nothing of it is in the window.
 */
function onFirstOpen<P extends { open: boolean }>(load: () => Promise<ComponentType<P>>): ComponentType<P> {
  const Sheet = lazy(() => load().then((component) => ({ default: component })));
  return function OnFirstOpen(props: P) {
    const [opened, setOpened] = useState(props.open);
    if (props.open && !opened) setOpened(true);
    return opened ? (
      <Suspense fallback={null}>
        <Sheet {...(props as P & Attributes)} />
      </Suspense>
    ) : null;
  };
}

/** Settings with every pane: plugins, IM, usage, MCP, keys and the rest. */
export const SettingsDialog = onFirstOpen<ComponentProps<typeof SettingsDialogNow>>(() => import("~/components/dialogs/SettingsDialog").then((m) => m.SettingsDialog));
export const InboxDialog = onFirstOpen<ComponentProps<typeof InboxDialogNow>>(() => import("~/components/dialogs/InboxDialog").then((m) => m.InboxDialog));
export const FieldsDialog = onFirstOpen<ComponentProps<typeof FieldsDialogNow>>(() => import("~/components/dialogs/FieldsDialog").then((m) => m.FieldsDialog));

export function Review(props: ComponentProps<typeof ReviewNow>) {
  return (
    <Suspense fallback={<div className="ai-scroll ai-review" />}>
      <Looking {...props} />
    </Suspense>
  );
}

export function GraphView() {
  return (
    <Suspense fallback={<div className="graph-region" />}>
      <Graph />
    </Suspense>
  );
}

export function IssueBody(props: ComponentProps<typeof IssueBodyNow>) {
  return (
    <Suspense fallback={<div className={props.className} />}>
      <Body {...props} />
    </Suspense>
  );
}

export function FileViewer(props: ComponentProps<typeof FileViewerNow>) {
  return (
    <Suspense fallback={<div className="file-view" data-mime={props.content.mime} />}>
      <Viewer {...props} />
    </Suspense>
  );
}

export function NoteEditor(props: ComponentProps<typeof NoteEditorNow>) {
  return (
    <Suspense fallback={<div className="note-editor" />}>
      <Editor {...props} />
    </Suspense>
  );
}

export function AnnouncementBody(props: ComponentProps<typeof AnnouncementBodyNow>) {
  return (
    <Suspense fallback={<article className="md-view body-prose" />}>
      <Announcement {...props} />
    </Suspense>
  );
}
