import { useState } from "react";
import type { McpClientSettings, McpServerConfig, McpServerView, McpTestResult } from "@tomradex/mcp-client";
import { Icon } from "~/components/icons";
import { SectionHead, Tag } from "~/components/ui/atoms";
import { useI18n, type MessageKey } from "~/lib/i18n";
import { useMcpServers, useParseMcpConfig, useReconnectMcpServer, useTestMcpServer } from "~/lib/mcpClient";
import { useSaveSettings, useSettings } from "~/lib/queries";
import { PlainSecretNote } from "~/components/ui/PlainSecretNote";
import { cn } from "~/lib/utils";

const ID = /^[a-z0-9][a-z0-9_-]{0,23}$/;

const STATE_KEY: Record<McpServerView["state"], MessageKey> = {
  connected: "mcpServers.stateConnected",
  connecting: "mcpServers.stateConnecting",
  failed: "mcpServers.stateFailed",
  off: "mcpServers.stateOff"
};

/** The form edits text; a configuration is made from it only to test or save. */
interface Draft {
  id: string;
  enabled: boolean;
  kind: "stdio" | "http";
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  tools: string;
  timeout: string;
}

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
const pairs = (text: string, sep: string) =>
  Object.fromEntries(lines(text).map((l) => (l.includes(sep) ? [l.slice(0, l.indexOf(sep)).trim(), l.slice(l.indexOf(sep) + 1).trim()] : [l, ""])));
const unpair = (record: Record<string, string>, sep: string) => Object.entries(record).map(([k, v]) => `${k}${sep}${v}`).join("\n");

function toDraft(config?: McpServerConfig): Draft {
  const t = config?.transport;
  return {
    id: config?.id ?? "",
    enabled: config?.enabled ?? true,
    kind: t?.type ?? "stdio",
    command: t?.type === "stdio" ? t.command : "",
    args: t?.type === "stdio" ? t.args.join("\n") : "",
    env: t?.type === "stdio" ? unpair(t.env, "=") : "",
    cwd: t?.type === "stdio" ? (t.cwd ?? "") : "",
    url: t?.type === "http" ? t.url : "",
    headers: t?.type === "http" ? unpair(t.headers, ": ") : "",
    tools: config?.tools?.join("\n") ?? "",
    timeout: String(Math.round((config?.timeoutMs ?? 60_000) / 1000))
  };
}

function fromDraft(d: Draft): McpServerConfig {
  const transport: McpServerConfig["transport"] =
    d.kind === "stdio"
      ? { type: "stdio", command: d.command.trim(), args: lines(d.args), env: pairs(d.env, "="), ...(d.cwd.trim() ? { cwd: d.cwd.trim() } : {}) }
      : { type: "http", url: d.url.trim(), headers: pairs(d.headers, ":") };
  const tools = lines(d.tools);
  return { id: d.id.trim(), enabled: d.enabled, transport, ...(tools.length ? { tools } : {}), timeoutMs: Math.max(1, Number(d.timeout) || 60) * 1000 };
}

function TestResult({ result }: { result: McpTestResult }) {
  const { t } = useI18n();
  if (!result.ok) return <pre className="mcp-error" role="alert">{result.error}</pre>;
  return (
    <p className="meta-txt dense" data-testid="mcp-test-ok">
      <Icon name="i-check" size={12} style={{ color: "var(--accent)", display: "inline", verticalAlign: "-1px" }} />{" "}
      {t("mcpServers.testOk", { server: result.server ? `${result.server.name} ${result.server.version}` : "?", count: result.tools.length })}
      {result.tools.length > 0 && <span className="mono"> · {result.tools.slice(0, 12).join(", ")}{result.tools.length > 12 ? " …" : ""}</span>}
    </p>
  );
}

function ServerForm({ initial, taken, busy, onSave, onCancel }: { initial?: McpServerConfig; taken: string[]; busy: boolean; onSave: (config: McpServerConfig) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => toDraft(initial));
  const test = useTestMcpServer();
  const set = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    test.reset();
  };
  const id = draft.id.trim();
  const idError = !id ? t("mcpServers.required") : !ID.test(id) ? t("mcpServers.idInvalid") : taken.includes(id) ? t("mcpServers.idTaken") : null;
  const targetMissing = draft.kind === "stdio" ? !draft.command.trim() : !draft.url.trim();
  const valid = !idError && !targetMissing;
  const field = (key: keyof Draft, label: MessageKey, hint: MessageKey | null, multiline = false, placeholder = "") => (
    <div className="field">
      <label htmlFor={`mcp-${key}`}>{t(label)}</label>
      {multiline ? (
        <textarea id={`mcp-${key}`} className="input mono" rows={3} placeholder={placeholder} value={draft[key] as string} onChange={(e) => set({ [key]: e.target.value })} />
      ) : (
        <input id={`mcp-${key}`} className="input mono" placeholder={placeholder} value={draft[key] as string} onChange={(e) => set({ [key]: e.target.value })} />
      )}
      {hint && <span className="meta-txt">{t(hint)}</span>}
      {(key === "env" || key === "headers") && <PlainSecretNote />}
    </div>
  );
  return (
    <div className="panel stack-3" style={{ background: "var(--bg)" }} data-testid="mcp-form">
      <div className="grid-2">
        <div className="field">
          <label htmlFor="mcp-id">{t("mcpServers.idLabel")}</label>
          <input id="mcp-id" className="input mono" value={draft.id} placeholder="github" aria-invalid={!!idError && !!draft.id} onChange={(e) => set({ id: e.target.value })} />
          <span className="meta-txt" style={idError && draft.id ? { color: "var(--danger)" } : undefined}>
            {idError && draft.id ? idError : t("mcpServers.idHint", { example: `${id || "github"}__search` })}
          </span>
        </div>
        <div className="field">
          <label>{t("mcpServers.kindLabel")}</label>
          <div className="seg" role="group" aria-label={t("mcpServers.kindLabel")} style={{ alignSelf: "flex-start" }}>
            {(["stdio", "http"] as const).map((kind) => (
              <button key={kind} type="button" aria-pressed={draft.kind === kind} onClick={() => set({ kind })}>
                {t(kind === "stdio" ? "mcpServers.kindStdio" : "mcpServers.kindHttp")}
              </button>
            ))}
          </div>
        </div>
      </div>
      {draft.kind === "stdio" ? (
        <>
          {field("command", "mcpServers.commandLabel", "mcpServers.commandHint", false, "npx")}
          <div className="grid-2">
            {field("args", "mcpServers.argsLabel", "mcpServers.argsHint", true, "-y\n@modelcontextprotocol/server-github")}
            {field("env", "mcpServers.envLabel", "mcpServers.envHint", true, "GITHUB_TOKEN=…")}
          </div>
          {field("cwd", "mcpServers.cwdLabel", "mcpServers.optional")}
        </>
      ) : (
        <>
          {field("url", "mcpServers.urlLabel", "mcpServers.urlHint", false, "https://example.com/mcp")}
          {field("headers", "mcpServers.headersLabel", "mcpServers.headersHint", true, "Authorization: Bearer …")}
        </>
      )}
      <div className="grid-2">
        {field("tools", "mcpServers.toolsLabel", "mcpServers.toolsHint", true)}
        {field("timeout", "mcpServers.timeoutLabel", "mcpServers.timeoutHint")}
      </div>
      {test.data && <TestResult result={test.data} />}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={!valid || busy} onClick={() => onSave(fromDraft(draft))}>
          {t("mcpServers.save")}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!valid || test.isPending} onClick={() => test.mutate(fromDraft(draft))}>
          {test.isPending ? t("mcpServers.testing") : t("mcpServers.test")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function ImportForm({ busy, onAdd, onCancel }: { busy: boolean; onAdd: (servers: McpServerConfig[], done: () => void) => void; onCancel: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const parse = useParseMcpConfig();
  const [note, setNote] = useState<{ added: number; errors: string[] } | null>(null);
  const add = () =>
    parse.mutate(text, {
      onSuccess: ({ servers, errors }) => {
        if (!servers.length) return setNote({ added: 0, errors });
        onAdd(servers, () => {
          setNote({ added: servers.length, errors });
          if (!errors.length) setText("");
        });
      }
    });
  return (
    <div className="panel stack-3" style={{ background: "var(--bg)" }} data-testid="mcp-import">
      <div className="field">
        <label htmlFor="mcp-import-text">{t("mcpServers.importJson")}</label>
        <textarea id="mcp-import-text" className="input mono" rows={7} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} value={text} onChange={(e) => setText(e.target.value)} />
        <span className="meta-txt">{t("mcpServers.importHint")}</span>
      </div>
      {note && (
        <div className="meta-txt dense" role="status">
          {note.added ? t("mcpServers.importAdded", { count: note.added }) : t("mcpServers.importNothing")}
          {note.errors.map((e) => (
            <div key={e} style={{ color: "var(--danger)" }}>{e}</div>
          ))}
        </div>
      )}
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-secondary" disabled={!text.trim() || busy || parse.isPending} onClick={add}>
          {t("mcpServers.importAdd")}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onCancel}>
          {t("common.cancel")}
        </button>
      </div>
    </div>
  );
}

function ToolTable({ server }: { server: McpServerView }) {
  const { t } = useI18n();
  if (!server.tools.length) return <p className="meta-txt dense">{t("mcpServers.noTools")}</p>;
  return (
    <table className="tok-table" data-testid="mcp-tools">
      <thead>
        <tr>
          <th>{t("mcpServers.colTool")}</th>
          <th>{t("mcpServers.colRemote")}</th>
          <th>{t("mcpServers.colDescription")}</th>
        </tr>
      </thead>
      <tbody>
        {server.tools.map((tool) => (
          <tr key={tool.name} className={cn(tool.skipped && "off")}>
            <td className="mono">{tool.name}</td>
            <td className="mono">{tool.remote}</td>
            <td>
              {tool.skipped ? <span style={{ color: "var(--danger)" }}>{t("mcpServers.skipped", { reason: tool.skipped })}</span> : tool.description}
              {tool.approximate && (
                <>
                  {" "}
                  <Tag tone="faint" title={t("mcpServers.approximateTitle")}>{t("mcpServers.approximate")}</Tag>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ServerRow({
  server,
  busy,
  onToggle,
  onEdit,
  onRemove,
  onReconnect
}: {
  server: McpServerView;
  busy: boolean;
  onToggle: () => void;
  onEdit: () => void;
  onRemove: () => void;
  onReconnect: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const registered = server.tools.filter((tool) => !tool.skipped).length;
  const error = server.error?.split("\n").filter(Boolean).join(" · ") ?? "";
  const detail =
    server.state === "connected"
      ? t("mcpServers.detailConnected", { server: server.server ? `${server.server.name} ${server.server.version}` : server.id, count: registered })
      : server.state === "connecting"
        ? server.retry
          ? t("mcpServers.detailReconnecting", server.retry)
          : t("mcpServers.detailConnecting")
        : server.state === "off"
          ? t("mcpServers.detailOff")
          : error;
  const retrying = server.state === "failed" && server.retry;
  return (
    <div className="mcp-server" data-mcp-server={server.id} data-state={server.state}>
      <div className={cn("cfg-row", !server.enabled && "off")}>
        <Icon
          name={server.transport === "stdio" ? "i-terminal" : "i-globe"}
          size={15}
          style={{ color: server.state === "failed" ? "var(--danger)" : server.enabled ? "var(--accent)" : "var(--meta)" }}
        />
        <div className="cfg-name">
          {server.id}
          <span className="meta-txt mono mcp-oneline" title={server.target}>
            {server.target}
          </span>
          <div className="meta-txt dense mcp-oneline" title={server.state === "failed" ? server.error : undefined} style={server.state === "failed" ? { color: "var(--danger)" } : undefined}>
            {detail}
          </div>
        </div>
        <Tag tone={server.state === "connected" ? "strong" : server.state === "off" ? "faint" : "neutral"} title={retrying ? t("mcpServers.retryingTitle", retrying) : undefined}>
          {retrying ? t("mcpServers.stateRetrying", retrying) : t(STATE_KEY[server.state])}
        </Tag>
        {(server.state === "connected" || server.state === "failed") && (
          <button type="button" className="icon-btn" aria-expanded={open} aria-label={t("mcpServers.showTools")} title={t("mcpServers.showTools")} onClick={() => setOpen(!open)}>
            <Icon name={open ? "i-chevdown" : "i-chev"} size={14} />
          </button>
        )}
        {server.enabled && (
          <button type="button" className="icon-btn" aria-label={t("mcpServers.reconnect")} title={t("mcpServers.reconnect")} disabled={busy || server.state === "connecting"} onClick={onReconnect}>
            <Icon name="i-sync" size={14} />
          </button>
        )}
        <button type="button" className="icon-btn" aria-label={t("mcpServers.edit")} title={t("mcpServers.edit")} onClick={onEdit}>
          <Icon name="i-pen" size={14} />
        </button>
        {confirming ? (
          <button type="button" className="btn btn-danger" onClick={onRemove} onBlur={() => setConfirming(false)} autoFocus>
            {t("mcpServers.confirmRemove", { id: server.id })}
          </button>
        ) : (
          <button type="button" className="icon-btn danger" aria-label={t("mcpServers.remove")} title={t("mcpServers.remove")} onClick={() => setConfirming(true)}>
            <Icon name="i-trash" size={14} />
          </button>
        )}
        <button type="button" className="switch" role="switch" aria-checked={server.enabled} aria-label={t("mcpServers.enableAria", { id: server.id })} disabled={busy} onClick={onToggle} />
      </div>
      {open && (
        <div className="mcp-detail">
          {server.state === "failed" && server.error && <pre className="mcp-error">{server.error}</pre>}
          {server.state === "connected" && <ToolTable server={server} />}
        </div>
      )}
    </div>
  );
}

/**
 * External MCP servers: their configuration lives in the `mcpServers` settings
 * section, their live state comes from the plugin. Saving the section is what
 * connects, reconnects or drops a server.
 */
export function McpServersPane() {
  const { t } = useI18n();
  const settings = useSettings();
  const save = useSaveSettings();
  const servers = useMcpServers();
  const reconnect = useReconnectMcpServer();
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const configs = (settings.data?.mcpServers as McpClientSettings | undefined)?.servers ?? [];
  const views = servers.data ?? [];
  const connected = views.filter((s) => s.state === "connected").length;
  const persist = (next: McpServerConfig[], done?: () => void) => {
    if (!settings.data) return;
    setError(null);
    save.mutate({ ...settings.data, mcpServers: { servers: next } }, { onSuccess: () => done?.(), onError: (e) => setError(e.message) });
  };
  const replace = (id: string, config: McpServerConfig) => persist(configs.map((c) => (c.id === id ? config : c)), () => setEditing(null));

  return (
    <>
      <SectionHead title={t("mcpServers.label")} aside={<Tag tone="neutral">{t("mcpServers.connectedOfTotal", { connected, total: views.length })}</Tag>}>
        {t("mcpServers.lede")}
      </SectionHead>
      <div className="stack-3">
        {views.map((server) =>
          editing === server.id ? (
            <ServerForm
              key={server.id}
              initial={configs.find((c) => c.id === server.id)}
              taken={configs.map((c) => c.id).filter((id) => id !== server.id)}
              busy={save.isPending}
              onSave={(config) => replace(server.id, config)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <ServerRow
              key={server.id}
              server={server}
              busy={save.isPending || reconnect.isPending}
              onToggle={() => {
                const config = configs.find((c) => c.id === server.id);
                if (config) replace(server.id, { ...config, enabled: !config.enabled });
              }}
              onEdit={() => {
                setImporting(false);
                setEditing(server.id);
              }}
              onRemove={() => persist(configs.filter((c) => c.id !== server.id))}
              onReconnect={() => reconnect.mutate(server.id)}
            />
          )
        )}
        {!views.length && !editing && !importing && <p className="meta-txt">{t("mcpServers.empty")}</p>}
        {editing === "" && (
          <ServerForm
            taken={configs.map((c) => c.id)}
            busy={save.isPending}
            onSave={(config) => persist([...configs, config], () => setEditing(null))}
            onCancel={() => setEditing(null)}
          />
        )}
        {importing && <ImportForm busy={save.isPending} onAdd={(added, done) => persist([...configs, ...added], done)} onCancel={() => setImporting(false)} />}
        {error && (
          <p className="meta-txt dense" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        )}
        {editing === null && !importing && (
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing("")} data-testid="mcp-add">
              <Icon name="i-plus" size={13} /> {t("mcpServers.add")}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => setImporting(true)} data-testid="mcp-import-open">
              <Icon name="i-paste" size={13} /> {t("mcpServers.importJson")}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
