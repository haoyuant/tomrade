/** Built-ins that only look; the "ask" gate lets them through without a prompt. */
const READ_ONLY = ["read", "grep", "find", "ls", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource", "tool_search"];

/** How the "ask" gate titles its question, so Tomrade can tell it from another extension's. */
export const GATE_TITLE = "Pi wants to use ";

export interface BridgeOptions {
  url: string;
  token: string;
  /** Confirm every call that may change something, through the RPC dialog Tomrade answers. */
  approval: boolean;
  /** Tools of kits this conversation does not carry: pi declares them once its tool_search loads them. */
  deferred?: string[];
  /** Tools the server serves that this conversation must not see (another surface's). */
  hidden?: string[];
  /**
   * One short line per deferred kit, so the model knows what tool_search can find. Pi keeps 250 characters of the
   * description, under a heading that says the server's tools are not declared: hence saying that the rest are.
   */
  kits?: string[];
}

/**
 * The extension a pi process loads with `-e`. Pi has no flag for an MCP
 * server, so this registers Tomrade's as direct tools for the session only —
 * the user's own mcp.json is never touched. Plain JS, valid as TypeScript.
 */
export function bridgeSource(options: BridgeOptions): string {
  const toolExposure = Object.fromEntries([...(options.deferred ?? []).map((name) => [name, "deferred"]), ...(options.hidden ?? []).map((name) => [name, "hidden"])]);
  const server = {
    url: options.url,
    headers: { "X-Tomrade-Run": options.token },
    exposure: "direct",
    ...(Object.keys(toolExposure).length ? { toolExposure } : {}),
    // Compound tools call a worker model and can outlast pi's 60s default.
    timeout: 600,
    description: options.kits?.length ? `Tomrade: your mcp__tomrade__ tools are the project's backlog. More via tool_search when asked: ${options.kits.join("; ")}` : "Tomrade: this project's backlog, tickets, files and workflows"
  };
  return `const server = ${JSON.stringify(server)};
const approval = ${options.approval};
const readOnly = new Set(${JSON.stringify(READ_ONLY)});

export default function (pi) {
  pi.registerMcpServer("tomrade", server);
  if (!approval) return;
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName.startsWith("mcp__tomrade__") || readOnly.has(event.toolName)) return;
    if (pi.getAllTools().find((tool) => tool.name === event.toolName)?.annotations?.readOnlyHint === true) return;
    if (await ctx.ui.confirm(${JSON.stringify(GATE_TITLE)} + event.toolName, JSON.stringify(event.input, null, 2))) return;
    return { block: true, reason: "The user did not approve " + event.toolName };
  });
}
`;
}
