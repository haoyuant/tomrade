import type { Item, OplogEntry } from "@tomrade/domain";
import { Icon } from "~/components/icons";
import { LiveDot, Num, Spacer } from "~/components/ui/atoms";
import { agoLabel } from "~/lib/domain";
import { useMcpUrl, useOplog, useStatusItems } from "~/lib/queries";

const host = (url: string | null) => (url ? url.replace(/^https?:\/\//, "").replace(/\/mcp$/, "") : null);

/** The most recent write, with its author — the agent collaboration at rest. */
function Ribbon({ entry }: { entry: OplogEntry }) {
  const after = (entry.after ?? entry.before) as Item | null;
  const verb = entry.op === "create" ? "created" : entry.op === "delete" ? "deleted" : entry.op === "purge" ? "permanently deleted" : "updated";
  return (
    <span className="status-item">
      {entry.by.startsWith("ai:") && <span className="ribbon-tick" />}
      <Num>{entry.by}</Num> {verb} {after?.key ?? entry.entity} · {agoLabel(entry.at)}
    </span>
  );
}

export function StatusBar({ projectId, onUndo, children }: { projectId?: string; onUndo?: () => void; children?: React.ReactNode }) {
  const mcp = useMcpUrl();
  const oplog = useOplog(1);
  const plugins = useStatusItems(projectId);
  const latest = oplog.data?.[0];

  return (
    <footer className="statusbar">
      <span className="status-item">
        <LiveDot /> MCP <Num>{host(mcp.data ?? null) ?? "offline"}</Num>
      </span>
      {latest && <Ribbon entry={latest} />}
      {plugins.data?.map((s) => (
        <span className="status-item" key={s.id}>
          {s.text}
        </span>
      ))}
      {onUndo && (
        <button type="button" className="btn btn-ghost" style={{ padding: "2px 7px", fontSize: "var(--text-xs)" }} onClick={onUndo} title="Undo — ⌘Z">
          <Icon name="i-undo" size={13} /> Undo
        </button>
      )}
      <Spacer />
      {children}
    </footer>
  );
}
