/** Built-ins that only look; the "ask" gate lets them through without a prompt. */
const READ_ONLY = ["read", "grep", "find", "ls", "list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];

export interface BridgeOptions {
  url: string;
  token: string;
  /** Confirm every call that may change something, through the RPC dialog Tomrade answers. */
  approval: boolean;
}

/**
 * The extension a pi process loads with `-e`. Pi has no flag for an MCP
 * server, so this registers Tomrade's as direct tools for the session only —
 * the user's own mcp.json is never touched. Plain JS, valid as TypeScript.
 */
export function bridgeSource(options: BridgeOptions): string {
  const server = {
    url: options.url,
    headers: { "X-Tomrade-Run": options.token },
    exposure: "direct",
    // Compound tools call a worker model and can outlast pi's 60s default.
    timeout: 600,
    description: "Tomrade: this project's backlog, tickets, files and workflows"
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
    if (await ctx.ui.confirm("Pi wants to use " + event.toolName, JSON.stringify(event.input, null, 2))) return;
    return { block: true, reason: "The user did not approve " + event.toolName };
  });
}
`;
}
