// A stdio MCP server for the tests: plain JSON Schemas (one dotted name, one draft-07 ref), an error result,
// structured content, a tool that grows the list, and one that makes the process exit.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

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
  { name: "exit", description: "Exit the process", inputSchema: object() }
];

const server = new Server({ name: "fixture", version: "1.2.3" }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
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
    default:
      return { ...text(`unknown tool ${name}`), isError: true };
  }
});
await server.connect(new StdioServerTransport());
