import type { EngineView, McpLinkView } from "@tomradex/agent";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";

/**
 * Inside a local agent's engine row: whether sessions the person starts in a
 * terminal, anywhere, reach this Tomrade, and one click to add, update or
 * remove Tomrade in the agent's own user-level settings — per config folder
 * when the person keeps several (one per account).
 */
export function McpLinkSection({ engine }: { engine: EngineView }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const key = ["agent", "mcpLink", engine.id];
  const status = useQuery({ queryKey: key, queryFn: () => invoke("agent.mcpLink", engine.id) });
  const change = useMutation({
    mutationFn: ({ connect, profile }: { connect: boolean; profile?: string }) => invoke(connect ? "agent.linkMcp" : "agent.unlinkMcp", engine.id, profile),
    onSuccess: (view: McpLinkView) => qc.setQueryData(key, view)
  });
  const view = change.data ?? status.data;
  const failure = change.error?.message ?? status.error?.message;
  const rows = view?.profiles ?? (view ? [view] : []);

  return (
    <div className="stack-2 mcp-link" data-testid={`mcp-link-${engine.id}`} data-state={view?.state}>
      <p className="cli-guide-head">{t("mcpLink.title")}</p>
      {!view && <p className="meta-txt">{t("mcpLink.checking", { title: engine.title })}</p>}
      {rows.length > 1 && <p className="meta-txt dense">{t("mcpLink.profiles", { title: engine.title })}</p>}
      {rows.map((row) => (
        <McpLinkRow
          key={row.profile ?? "own"}
          engine={engine}
          view={row}
          named={rows.length > 1}
          busy={change.isPending || status.isFetching}
          working={change.isPending && change.variables?.profile === row.profile}
          onChange={(connect) => change.mutate({ connect, profile: row.profile })}
        />
      ))}
      {failure && <p className="meta-txt cli-warn" role="alert">{t("mcpLink.failed", { title: engine.title, error: failure })}</p>}
    </div>
  );
}

function McpLinkRow({ engine, view, named, busy, working, onChange }: { engine: EngineView; view: McpLinkView; named: boolean; busy: boolean; working: boolean; onChange: (connect: boolean) => void }) {
  const { t, tx } = useI18n();
  const title = engine.title;
  // Without a working CLI here, the command is the way to do it.
  const manual = view.state !== "unavailable" && (!!view.error || engine.cli?.state !== "ready");
  const profile = view.profile?.split(/[\\/]/).filter(Boolean).at(-1);

  return (
    <div className="stack-2 mcp-link-profile" data-profile={view.profile} data-state={view.state}>
      {named && profile && <strong className="cfg-name mono">{profile}</strong>}
      <p className="meta-txt">
        {view.state === "stale" ? t("mcpLink.stale", { title, url: view.configuredUrl ?? "" }) : t(`mcpLink.${view.state}`, { title })}
      </p>
      {view.file && view.state !== "missing" && <p className="meta-txt dense">{tx("mcpLink.file", { path: <span className="mono">{view.file}</span> })}</p>}
      {view.state !== "connected" && view.state !== "unavailable" && <p className="meta-txt dense">{t("mcpLink.cost", { title })}</p>}
      {view.state !== "unavailable" && (
        <div className="row">
          {view.state !== "connected" && (
            <button type="button" className="btn btn-secondary mcp-link-connect" disabled={busy} onClick={() => onChange(true)}>
              {working ? t("mcpLink.working") : t(view.state === "stale" ? "mcpLink.update" : "mcpLink.connect")}
            </button>
          )}
          {view.configuredUrl && (
            <button type="button" className="btn btn-ghost mcp-link-disconnect" disabled={busy} onClick={() => onChange(false)}>
              {t("mcpLink.disconnect")}
            </button>
          )}
        </div>
      )}
      {view.error && <p className="meta-txt cli-warn" role="alert">{t("mcpLink.failed", { title, error: view.error })}</p>}
      {manual && (
        <p className="meta-txt dense mcp-link-manual">
          {t("mcpLink.manual")} <code>{view.state === "connected" ? view.manual.disconnect : view.manual.connect}</code>
        </p>
      )}
    </div>
  );
}
