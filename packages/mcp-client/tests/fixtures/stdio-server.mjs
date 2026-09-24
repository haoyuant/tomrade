// A stdio MCP server for the tests: plain JSON Schemas (one dotted name, one draft-07 ref), an error result,
// structured content, a tool that grows the list, one that makes the process exit, and one that waits to be cancelled.
// FIXTURE_LOG names a file it appends "start" and "cancelled" to; FIXTURE_EXIT_AFTER_MS makes it die soon after it connects.
import fs from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const log = (line) => process.env.FIXTURE_LOG && fs.appendFileSync(process.env.FIXTURE_LOG, `${line}\n`);
log("start");

if (process.env.FIXTURE_CRASH) {
  process.stderr.write("fixture: missing API key\n");
  process.exit(1);
}

const object = (properties = {}, required = []) => ({ type: "object", properties, required });
const tools = [
  { name: "echo", description: "Echo text back", inputSchema: object({ text: { type: "string" } }, ["text"]) },
  { name: "add", description: "Add two numbers", inputSchema: object({ a: { type: "number" }, b: { type: "number" } }, ["a", "b"]) },
  { name: "fail", description: "Always fails", inputSchema: object() },
  { name: "files.read", description: "Read a file", inputSchema: { type: "object", properties: { path: { $ref: "#/definitions/Path" } }, required: ["path"], definitions: { Path: { type: "string" } } } },
  { name: "env", description: "Read an environment variable", inputSchema: object({ name: { type: "string" } }, ["name"]) },
  { name: "pid", description: "The server's process id", inputSchema: object() },
  { name: "grow", description: "Add a tool and announce it", inputSchema: object() },
  { name: "exit", description: "Exit the process", inputSchema: object() },
  { name: "sleep", description: "Wait, unless cancelled", inputSchema: object({ ms: { type: "number" } }, ["ms"]) }
];

const server = new Server({ name: "fixture", version: "1.2.3" }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;
  const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
  switch (name) {
    case "echo":
      return text(args.text);
    case "add":
      return { content: [], structuredContent: { sum: args.a + args.b } };
    case "fail":
      return { ...text("nope"), isError: true };
    case "files.read":
      return text(`read ${args.path}`);
    case "env":
      return text(process.env[args.name] ?? "");
    case "pid":
      return text(process.pid);
    case "grow":
      tools.push({ name: "grown", description: "Appeared later", inputSchema: object() });
      await server.sendToolListChanged();
      return text("grew");
    case "exit":
      setTimeout(() => {
        process.stderr.write("fixture: bye\n");
        process.exit(3);
      }, 20);
      return text("bye");
    case "sleep":
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(text("slept")), args.ms);
        extra.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          log("cancelled");
          resolve(text("cancelled"));
        });
      });
    default:
      return { ...text(`unknown tool ${name}`), isError: true };
  }
});
await server.connect(new StdioServerTransport());
if (process.env.FIXTURE_EXIT_AFTER_MS) setTimeout(() => process.exit(4), Number(process.env.FIXTURE_EXIT_AFTER_MS));
