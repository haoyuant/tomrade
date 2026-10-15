import type { EngineView, McpLinkView } from "@tomradex/agent";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";

/**
 * Inside a local agent's engine row: whether sessions the person starts in a
 * terminal, anywhere, reach this Tomrade, and one click to add, update or
 * remove Tomrade in the agent's own user-level settings.
 */
export function McpLinkSection({ engine }: { engine: EngineView }) {
  const { t, tx } = useI18n();
  const qc = useQueryClient();
  const key = ["agent", "mcpLink", engine.id];
  const status = useQuery({ queryKey: key, queryFn: () => invoke("agent.mcpLink", engine.id) });
  const change = useMutation({
    mutationFn: (connect: boolean) => invoke(connect ? "agent.linkMcp" : "agent.unlinkMcp", engine.id),
    onSuccess: (view: McpLinkView) => qc.setQueryData(key, view)
  });
  const view = change.data ?? status.data;
  const title = engine.title;
  const error = change.error?.message ?? status.error?.message ?? view?.error;
  const busy = change.isPending || status.isFetching;
  // Without a working CLI here, the command is the way to do it.
  const manual = view && view.state !== "unavailable" && (!!error || engine.cli?.state !== "ready");

  return (
    <div className="stack-2 mcp-link" data-testid={`mcp-link-${engine.id}`} data-state={view?.state}>
      <p className="cli-guide-head">{t("mcpLink.title")}</p>
      <p className="meta-txt">
        {!view
          ? t("mcpLink.checking", { title })
          : view.state === "stale"
            ? t("mcpLink.stale", { title, url: view.configuredUrl ?? "" })
            : t(`mcpLink.${view.state}`, { title })}
      </p>
      {view?.file && view.state !== "missing" && <p className="meta-txt dense">{tx("mcpLink.file", { path: <span className="mono">{view.file}</span> })}</p>}
      {view && view.state !== "connected" && view.state !== "unavailable" && <p className="meta-txt dense">{t("mcpLink.cost", { title })}</p>}
      {view && view.state !== "unavailable" && (
        <div className="row">
          {view.state !== "connected" && (
            <button type="button" className="btn btn-secondary mcp-link-connect" disabled={busy} onClick={() => change.mutate(true)}>
              {change.isPending ? t("mcpLink.working") : t(view.state === "stale" ? "mcpLink.update" : "mcpLink.connect")}
            </button>
          )}
          {view.configuredUrl && (
            <button type="button" className="btn btn-ghost mcp-link-disconnect" disabled={busy} onClick={() => change.mutate(false)}>
              {t("mcpLink.disconnect")}
            </button>
          )}
        </div>
      )}
      {error && <p className="meta-txt cli-warn" role="alert">{t("mcpLink.failed", { title, error })}</p>}
      {manual && (
        <p className="meta-txt dense mcp-link-manual">
          {t("mcpLink.manual")} <code>{view.state === "connected" ? view.manual.disconnect : view.manual.connect}</code>
        </p>
      )}
    </div>
  );
}
