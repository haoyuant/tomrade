import { useEffect, useMemo, useRef, useState } from "react";
import { LAYOUT_SHELL_FILE, pluginFileUrl, type LayoutInfo } from "@tomradex/contributions";
import { pluginLayoutId, type Patch, type PluginLayout as PluginLayoutId } from "@tomradex/domain";
import type { LayoutHandle, LayoutModule, LayoutState } from "@tomradex/plugin-sdk";
import { messageOf } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { useLayouts, usePatchItem } from "~/lib/queries";
import { useLook } from "~/lib/surface-look";
import { LayoutFeed } from "~/plugin-layout/feed";
import { nativeApi, serveFrame, type LayoutActions } from "~/plugin-layout/host";
import { CONNECT, type ConnectMessage } from "~/plugin-layout/protocol";
import { useSelectedId, useWorkspace } from "./context";

/** The backlog region drawn by a plugin's layout: its module mounted native in this window, or in a frame of its own. */
export function PluginLayoutRegion({ layout }: { layout: PluginLayoutId }) {
  const { t } = useI18n();
  const layouts = useLayouts();
  const id = pluginLayoutId(layout);
  const info = layouts.data?.find((l) => l.id === id);
  const state = useLayoutState();
  const actions = useLayoutActions();
  if (!layouts.data) return null;
  if (!info) return <Notice text={t("pluginLayout.missing", { id })} />;
  // A change of module or mode is a different page: start it over.
  const key = `${info.pluginId}/${info.module}:${info.render}`;
  return info.render === "native" ? <NativeLayout key={key} info={info} state={state} actions={actions} /> : <SandboxLayout key={key} info={info} state={state} actions={actions} />;
}

function Notice({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="items-error plugin-layout-notice" role="alert">
      <p>{text}</p>
      {detail && <code className="route-error-detail">{detail}</code>}
    </div>
  );
}

/** What the layout sees: the view's own tickets and settings, the selection, and the look — a new object only when one of them changes. */
function useLayoutState(): LayoutState {
  const ws = useWorkspace();
  const selectedId = useSelectedId();
  const look = useLook();
  const { project, visible, fields, query } = ws;
  return useMemo(() => ({ projectId: project.id, items: visible, fields, query, selectedId, look }), [project.id, visible, fields, query, selectedId, look]);
}

/** Opening a ticket and patching one are the workspace's own moves: the write is the person's, undoable, refused where any would be. */
function useLayoutActions(): LayoutActions {
  const ws = useWorkspace();
  const patch = usePatchItem(ws.project.id);
  const items = useRef(ws.items);
  items.current = ws.items;
  const { select } = ws;
  const { mutateAsync } = patch;
  return useMemo(
    () => ({
      select: async (id: string | null) => select(id),
      update: async (id: string, change: Patch) => {
        const item = items.current.find((i) => i.id === id);
        if (!item) throw new Error(`no ticket ${id} in this view`);
        await mutateAsync({ id, patch: change, baseVersion: item.version });
      }
    }),
    [select, mutateAsync]
  );
}

/** One feed per mounted layout, fed every render the state changes and dropped with it. */
function useFeed(state: LayoutState): LayoutFeed {
  const ref = useRef<LayoutFeed | null>(null);
  ref.current ??= new LayoutFeed(state);
  useEffect(() => ref.current?.set(state), [state]);
  useEffect(() => () => ref.current?.dispose(), []);
  return ref.current;
}

interface MountProps {
  info: LayoutInfo;
  state: LayoutState;
  actions: LayoutActions;
}

function NativeLayout({ info, state, actions }: MountProps) {
  const { t } = useI18n();
  const root = useRef<HTMLDivElement>(null);
  const feed = useFeed(state);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const el = root.current!;
    let gone = false;
    let handle: LayoutHandle | null = null;
    const api = nativeApi(feed, actions);
    import(/* @vite-ignore */ pluginFileUrl(info.pluginId, info.module))
      .then(async (mod: { default?: LayoutModule }) => {
        if (gone) return;
        if (typeof mod.default?.mount !== "function") throw new Error("the module's default export has no mount()");
        handle = await mod.default.mount(el, api);
        if (gone) handle.unmount();
      })
      .catch((e: unknown) => !gone && setError(messageOf(e)));
    return () => {
      gone = true;
      handle?.unmount();
      el.replaceChildren();
    };
  }, [feed, actions, info.pluginId, info.module]);
  return (
    <div className="plugin-layout-region" data-render="native" data-layout-id={info.id}>
      <div ref={root} className="plugin-layout-root" />
      {error && <Notice text={t("pluginLayout.failed")} detail={error} />}
    </div>
  );
}

function SandboxLayout({ info, state, actions }: MountProps) {
  const { t } = useI18n();
  const frame = useRef<HTMLIFrameElement>(null);
  const feed = useFeed(state);
  const [error, setError] = useState<string | null>(null);
  // The frame's page is the app's, served under the plugin's own origin: that origin is the frame's, never this window's.
  const src = useMemo(() => pluginFileUrl(info.pluginId, LAYOUT_SHELL_FILE), [info.pluginId]);
  useEffect(() => {
    const el = frame.current!;
    let stop: (() => void) | null = null;
    const connect = () => {
      stop?.();
      const channel = new MessageChannel();
      const message: ConnectMessage = { type: CONNECT, module: pluginFileUrl(info.pluginId, info.module), state: feed.state };
      // The frame's origin is on a scheme this window's URL parser does not know, so it cannot be named; the port goes to that window alone.
      el.contentWindow?.postMessage(message, "*", [channel.port2]);
      stop = serveFrame(feed, channel.port1, actions, setError);
    };
    el.addEventListener("load", connect);
    return () => {
      el.removeEventListener("load", connect);
      stop?.();
    };
  }, [feed, actions, info.pluginId, info.module]);
  return (
    <div className="plugin-layout-region" data-render="sandbox" data-layout-id={info.id}>
      <iframe ref={frame} className="plugin-layout-frame" title={t("pluginLayout.frame", { title: info.title })} sandbox="allow-scripts allow-same-origin" src={src} />
      {error && <Notice text={t("pluginLayout.failed")} detail={error} />}
    </div>
  );
}
