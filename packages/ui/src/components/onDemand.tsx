import { lazy, Suspense, type ComponentProps } from "react";
import type { IssueBody as IssueBodyNow } from "~/components/issue/IssueBody";
import type { FileViewer as FileViewerNow } from "~/components/files/FileViewer";
import type { NoteEditor as NoteEditorNow } from "~/components/files/NoteEditor";
import type { AnnouncementBody as AnnouncementBodyNow } from "~/components/dialogs/AnnouncementBody";

/**
 * Views that bring a heavy library — CodeMirror, React Flow and dagre, the Markdown renderer — loaded the first time
 * one shows, so a window starts with what its first screen needs. Until then each holds its place with its own box.
 */
const Graph = lazy(() => import("~/components/workspace/GraphView").then((m) => ({ default: m.GraphView })));
const Body = lazy(() => import("~/components/issue/IssueBody").then((m) => ({ default: m.IssueBody })));
const Viewer = lazy(() => import("~/components/files/FileViewer").then((m) => ({ default: m.FileViewer })));
const Editor = lazy(() => import("~/components/files/NoteEditor").then((m) => ({ default: m.NoteEditor })));
const Announcement = lazy(() => import("~/components/dialogs/AnnouncementBody").then((m) => ({ default: m.AnnouncementBody })));

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
