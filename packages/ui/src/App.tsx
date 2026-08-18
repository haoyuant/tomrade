import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Item, ItemStatus, OplogEntry } from "@tomrade/core";

const STATUSES: ItemStatus[] = ["backlog", "todo", "doing", "verifying", "done", "cancelled"];

function StatusBadge({ item }: { item: Item }) {
  return (
    <span style={{
      background: item.humanLocked ? "#fff3cd" : "#e7f3ff",
      color: item.humanLocked ? "#8a6d00" : "#1a5f9e",
      borderRadius: 4,
      padding: "2px 8px",
      fontSize: 12,
      marginLeft: 8
    }}>
      {item.status} · v{item.version} · {item.updatedBy}
      {item.humanLocked ? " · 🔒" : ""}
    </span>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");

  const items = useQuery({ queryKey: ["items"], queryFn: () => window.tomrade.list() });
  const oplog = useQuery({ queryKey: ["oplog"], queryFn: () => window.tomrade.recentOplog(10) });
  const mcp = useQuery({ queryKey: ["mcp"], queryFn: () => window.tomrade.mcpUrl() });

  const create = useMutation({
    mutationFn: (t: string) => window.tomrade.create({ title: t }),
    onSuccess: () => { setTitle(""); void queryClient.invalidateQueries({ queryKey: ["items"] }); void queryClient.invalidateQueries({ queryKey: ["oplog"] }); }
  });

  const setStatus = useMutation({
    mutationFn: ({ item, status }: { item: Item; status: ItemStatus }) =>
      window.tomrade.update(item.id, { status }, item.version),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["items"] }); void queryClient.invalidateQueries({ queryKey: ["oplog"] }); },
    onError: (e: unknown) => alert(e instanceof Error ? e.message : String(e))
  });

  const remove = useMutation({
    mutationFn: (id: string) => window.tomrade.remove(id),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["items"] }); void queryClient.invalidateQueries({ queryKey: ["oplog"] }); }
  });

  const undo = useMutation({
    mutationFn: () => window.tomrade.undo(),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ["items"] }); void queryClient.invalidateQueries({ queryKey: ["oplog"] }); }
  });

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 720, margin: "0 auto", padding: 24 }}>
      <h1>Tomrade</h1>
      {mcp.data && (
        <p style={{ fontSize: 13, color: "#2a7a2a", background: "#eef7ee", padding: "6px 12px", borderRadius: 6 }}>
          🤖 MCP server: <code>{mcp.data}</code> — connect VS Code agents here
        </p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); if (title.trim()) create.mutate(title.trim()); }}>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="New ticket title…"
          style={{ padding: 8, width: 300 }}
        />
        <button type="submit" disabled={create.isPending}>Add</button>
        <button type="button" onClick={() => undo.mutate()} disabled={undo.isPending}>↩ Undo</button>
      </form>

      {items.isLoading && <p>Loading…</p>}
      {items.error && <p style={{ color: "red" }}>{String(items.error)}</p>}

      <ul style={{ listStyle: "none", padding: 0 }}>
        {(items.data ?? []).map((item) => (
          <li key={item.id} style={{ borderBottom: "1px solid #eee", padding: "10px 0" }}>
            <strong>{item.title}</strong>
            <StatusBadge item={item} />
            <div style={{ marginTop: 6 }}>
              <select
                value={item.status}
                onChange={(e) => setStatus.mutate({ item, status: e.target.value as ItemStatus })}
              >
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <button onClick={() => remove.mutate(item.id)} style={{ marginLeft: 8 }}>Delete</button>
            </div>
          </li>
        ))}
      </ul>

      <h2>Recent operations</h2>
      <ul style={{ fontSize: 13, color: "#555" }}>
        {(oplog.data ?? []).map((op: OplogEntry) => (
          <li key={op.seq}>{op.op} · {op.entityId.slice(0, 8)} · by {op.by}</li>
        ))}
      </ul>
    </div>
  );
}