/** A few calls to a running Tomrade's MCP server: initialize once, then tools/call. */
export async function mcpClient(url: string) {
  let session: string | undefined;
  let id = 0;
  const post = async (method: string, params: unknown, notify = false): Promise<any> => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++id, method, params })
    });
    session ??= res.headers.get("mcp-session-id") ?? undefined;
    if (notify) return null;
    const text = await res.text();
    // Streamable HTTP may answer as an event stream: the reply is the data line carrying this id.
    const message = res.headers.get("content-type")?.includes("text/event-stream")
      ? text.split("\n").filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5))).find((m) => m.id === id)
      : JSON.parse(text);
    if (message?.error) throw new Error(message.error.message);
    return message?.result;
  };
  await post("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "tomrade-store", version: "1" } });
  await post("notifications/initialized", {}, true);
  return {
    async call(name: string, args: Record<string, unknown>): Promise<any> {
      const result = await post("tools/call", { name, arguments: args });
      const text = result?.content?.[0]?.text;
      if (result?.isError) throw new Error(text ?? `${name} failed`);
      try { return JSON.parse(text); } catch { return text; }
    }
  };
}
