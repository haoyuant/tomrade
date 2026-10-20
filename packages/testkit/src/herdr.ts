import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/** A pane the fake herdr holds: a shell, perhaps with an agent herdr "detected" in it. */
export interface FakePane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd: string;
  label: string | null;
  agent: string | null;
  agent_status: string;
  /** What `pane.read` returns. */
  text: string;
  /** What runs in the foreground, for `pane.process_info`; the shell when unset. */
  foreground?: { cmdline: string; cwd: string };
  /** The agent's own session, as herdr's detection reports it. */
  agent_session?: { source: string; agent: string; kind: string; value: string } | null;
  /** The title the program in the pane set, styling stripped. */
  terminal_title_stripped?: string | null;
}

export interface FakeHerdrCall {
  method: string;
  params: Record<string, unknown>;
}

type Reply = { result: unknown } | { error: { code: string; message: string } };

/**
 * A server that speaks herdr's socket protocol as herdr 0.9.5 does: one JSON
 * request per line, one reply per line, and subscriptions that keep their
 * connection and receive events — enough of workspaces, panes and agents for
 * a ticket to be started, followed and continued in it.
 */
export class FakeHerdr {
  readonly socket: string;
  readonly calls: FakeHerdrCall[] = [];
  readonly panes = new Map<string, FakePane>();
  private server: net.Server | null = null;
  private readonly streams = new Set<{ connection: net.Socket; subscriptions: { type: string; pane_id?: string }[] }>();
  private workspaces = 0;
  /** The workspaces it holds, with their labels and how many panes and tabs each has made. */
  readonly spaces = new Map<string, { label: string; panes: number; tabs: number }>();
  /** The build the server says it runs, in its pong. */
  version = "0.9.5";
  /** Whether a herdr client (its terminal UI) is attached: without one, a toast has nobody to show it. */
  attached = true;
  /** Answers tried before the built-in ones; undefined leaves the call to them. */
  answer: (method: string, params: Record<string, unknown>) => Reply | undefined = () => undefined;

  /** A folder of its own, short: a Unix socket's path may not run past about a hundred characters. */
  constructor(dir = fs.mkdtempSync(path.join(os.tmpdir(), "h-"))) {
    fs.mkdirSync(dir, { recursive: true });
    this.socket = path.join(dir, "s.sock");
    this.start();
  }

  /** Listen (again) on the socket, as a herdr server that came (back) up. */
  start(): void {
    if (this.server) return;
    fs.rmSync(this.socket, { force: true });
    this.server = net.createServer((connection) => this.serve(connection));
    this.server.listen(this.socket);
  }

  /** Stop answering and drop every subscription, as a herdr server that went away. */
  stop(): void {
    for (const stream of this.streams) stream.connection.destroy();
    this.streams.clear();
    this.server?.close();
    this.server = null;
  }

  close(): void {
    this.stop();
  }

  /** The calls made with this method, oldest first. */
  of(method: string): Record<string, unknown>[] {
    return this.calls.filter((call) => call.method === method).map((call) => call.params);
  }

  /** herdr saw an agent in the pane, in this state; the pane's subscribers hear it. */
  setStatus(paneId: string, agent: string | null, status: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error(`no pane ${paneId}`);
    pane.agent = agent;
    pane.agent_status = status;
    this.push({ event: "pane.agent_status_changed", data: { pane_id: paneId, workspace_id: pane.workspace_id, agent, agent_status: status } });
  }

  /** The pane's process ended and the pane closed with it. */
  exit(paneId: string): void {
    const pane = this.panes.get(paneId);
    if (!pane) throw new Error(`no pane ${paneId}`);
    this.panes.delete(paneId);
    this.push({ event: "pane_exited", data: { type: "pane_exited", pane_id: paneId, workspace_id: pane.workspace_id } });
    this.push({ event: "pane_closed", data: { type: "pane_closed", pane_id: paneId, workspace_id: pane.workspace_id } });
  }

  /** An event, to every subscription it matches: by its type, and by pane where the subscription names one. */
  push(event: { event: string; data: Record<string, unknown> }): void {
    const type = event.event.includes(".") ? event.event : event.event.replace("_", ".");
    for (const stream of this.streams) {
      if (stream.subscriptions.some((s) => s.type === type && (!s.pane_id || s.pane_id === event.data.pane_id))) stream.connection.write(`${JSON.stringify(event)}\n`);
    }
  }

  /** The panes of herdr's own making (workspace.create) are `w<n>:p1`. */
  createPane(cwd: string, label: string | null = null): FakePane {
    const n = ++this.workspaces;
    this.spaces.set(`w${n}`, { label: label ?? String(n), panes: 1, tabs: 1 });
    const pane: FakePane = { pane_id: `w${n}:p1`, workspace_id: `w${n}`, tab_id: `w${n}:t1`, cwd, label, agent: null, agent_status: "unknown", text: "" };
    this.panes.set(pane.pane_id, pane);
    return pane;
  }

  /** A new tab in a workspace: its pane is the workspace's next, `w<n>:p<m>`. */
  createTab(workspaceId: string, cwd: string, label: string | null = null): FakePane | null {
    const space = this.spaces.get(workspaceId);
    if (!space) return null;
    const pane: FakePane = { pane_id: `${workspaceId}:p${++space.panes}`, workspace_id: workspaceId, tab_id: `${workspaceId}:t${++space.tabs}`, cwd, label, agent: null, agent_status: "unknown", text: "" };
    this.panes.set(pane.pane_id, pane);
    return pane;
  }

  /** The person closed a workspace, and its panes with it. */
  closeWorkspace(workspaceId: string): void {
    this.spaces.delete(workspaceId);
    for (const [id, pane] of this.panes) if (pane.workspace_id === workspaceId) this.panes.delete(id);
  }

  private serve(connection: net.Socket): void {
    let buffer = "";
    connection.setEncoding("utf8");
    connection.on("error", () => undefined);
    connection.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const request = JSON.parse(line) as { id: string; method: string; params: Record<string, unknown> };
        const params = request.params ?? {};
        this.calls.push({ method: request.method, params });
        if (request.method === "events.subscribe") {
          const subscriptions = (params.subscriptions as { type: string; pane_id?: string }[]) ?? [];
          const missing = subscriptions.find((s) => s.pane_id && !this.panes.has(s.pane_id));
          if (missing) {
            connection.end(`${JSON.stringify({ id: request.id, error: { code: "pane_not_found", message: `pane ${missing.pane_id} not found` } })}\n`);
            return;
          }
          const stream = { connection, subscriptions };
          this.streams.add(stream);
          connection.once("close", () => this.streams.delete(stream));
          connection.write(`${JSON.stringify({ id: request.id, result: { type: "subscription_started" } })}\n`);
          continue;
        }
        const reply = this.answer(request.method, params) ?? this.reply(request.method, params);
        connection.write(`${JSON.stringify({ id: request.id, ...reply })}\n`);
      }
    });
  }

  private reply(method: string, params: Record<string, unknown>): Reply {
    const paneOf = (id: unknown) => (typeof id === "string" ? this.panes.get(id) : undefined);
    const notFound = (id: unknown): Reply => ({ error: { code: "pane_not_found", message: `pane ${String(id)} not found` } });
    const noAgent = (id: unknown): Reply => ({ error: { code: "agent_not_found", message: `agent target ${String(id)} not found` } });
    const noSpace = (id: unknown): Reply => ({ error: { code: "workspace_not_found", message: `workspace ${String(id)} not found` } });
    switch (method) {
      case "ping":
        return { result: { type: "pong", version: this.version, protocol: 22 } };
      case "workspace.create": {
        const pane = this.createPane(typeof params.cwd === "string" ? params.cwd : "/", typeof params.label === "string" ? params.label : null);
        const workspace = { workspace_id: pane.workspace_id, number: this.workspaces, label: pane.label ?? String(this.workspaces), focused: params.focus === true, pane_count: 1, tab_count: 1, active_tab_id: pane.tab_id, agent_status: "unknown" };
        return { result: { type: "workspace_created", workspace, tab: { tab_id: pane.tab_id, workspace_id: pane.workspace_id }, root_pane: { ...pane, focused: false, revision: 0 } } };
      }
      case "workspace.focus":
      case "tab.focus":
        return { result: { type: "ok" } };
      case "workspace.get": {
        const space = typeof params.workspace_id === "string" ? this.spaces.get(params.workspace_id) : undefined;
        return space ? { result: { type: "workspace_info", workspace: { workspace_id: params.workspace_id, label: space.label, tab_count: space.tabs, pane_count: space.panes, focused: false, agent_status: "unknown" } } } : noSpace(params.workspace_id);
      }
      case "tab.create": {
        const pane = typeof params.workspace_id === "string" ? this.createTab(params.workspace_id, typeof params.cwd === "string" ? params.cwd : "/", typeof params.label === "string" ? params.label : null) : null;
        if (!pane) return noSpace(params.workspace_id);
        return { result: { type: "tab_created", tab: { tab_id: pane.tab_id, workspace_id: pane.workspace_id, label: pane.label, focused: params.focus === true, pane_count: 1 }, root_pane: { ...pane, focused: false, revision: 0 } } };
      }
      case "tab.rename": {
        const pane = [...this.panes.values()].find((p) => p.tab_id === params.tab_id);
        if (!pane) return { error: { code: "tab_not_found", message: `tab ${String(params.tab_id)} not found` } };
        pane.label = typeof params.label === "string" ? params.label : pane.label;
        return { result: { type: "ok" } };
      }
      case "workspace.report_metadata":
        return typeof params.workspace_id === "string" && this.spaces.has(params.workspace_id) ? { result: { type: "ok" } } : noSpace(params.workspace_id);
      case "pane.report_metadata":
      case "pane.report_agent_session":
        return paneOf(params.pane_id) ? { result: { type: "ok" } } : notFound(params.pane_id);
      case "notification.show":
        return { result: { type: "notification_show", shown: this.attached, reason: this.attached ? "shown" : "no_foreground_client" } };
      case "pane.list":
        return { result: { type: "pane_list", panes: [...this.panes.values()].map((pane) => ({ ...pane, focused: false, revision: 0 })) } };
      case "pane.get": {
        const pane = paneOf(params.pane_id);
        return pane ? { result: { type: "pane_info", pane: { ...pane, focused: false, revision: 0 } } } : notFound(params.pane_id);
      }
      case "pane.process_info": {
        const pane = paneOf(params.pane_id);
        if (!pane) return notFound(params.pane_id);
        const fg = pane.foreground ?? { cmdline: "-zsh", cwd: pane.cwd };
        return { result: { type: "pane_process_info", process_info: { pane_id: pane.pane_id, shell_pid: 1, foreground_process_group_id: pane.foreground ? 2 : 1, foreground_processes: [{ ...fg, name: fg.cmdline.split(" ")[0], pid: pane.foreground ? 2 : 1 }] } } };
      }
      case "pane.close": {
        const pane = paneOf(params.pane_id);
        if (!pane) return notFound(params.pane_id);
        this.exit(pane.pane_id);
        return { result: { type: "ok" } };
      }
      case "pane.focus":
      case "pane.send_input":
      case "pane.send_text":
        return paneOf(params.pane_id) ? { result: { type: "ok" } } : notFound(params.pane_id);
      case "pane.read": {
        const pane = paneOf(params.pane_id);
        return pane ? { result: { type: "pane_read", read: { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id, source: params.source ?? "recent", format: "text", text: pane.text, revision: 0, truncated: false } } } : notFound(params.pane_id);
      }
      case "agent.get": {
        const pane = paneOf(params.target);
        return pane?.agent ? { result: { type: "agent_info", agent: { ...pane, focused: false, revision: 0 } } } : noAgent(params.target);
      }
      case "agent.prompt": {
        const pane = paneOf(params.target);
        if (!pane?.agent) return noAgent(params.target);
        if (pane.agent_status === "blocked") return { error: { code: "agent_blocked", message: `agent ${pane.pane_id} is blocked` } };
        return { result: { type: "agent_prompt", agent: { ...pane } } };
      }
      case "agent.read": {
        const pane = paneOf(params.target);
        return pane?.agent ? { result: { type: "agent_read", read: { text: pane.text } } } : noAgent(params.target);
      }
      default:
        return { error: { code: "invalid_request", message: `invalid request: unknown variant \`${method}\`` } };
    }
  }
}
