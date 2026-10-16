import { expect, it } from "vitest";
import type { ToolDescriptor } from "@tomradex/tools";
import { carriedKits, deferredTools, kitLines, type ThreadMessage } from "@tomradex/agent";

const tool = (name: string, kit?: string): ToolDescriptor => ({ name, title: name, description: "", inputSchema: {}, ...(kit ? { kit } : {}) });
const tools = [tool("list_items"), tool("create_template", "routines"), tool("schedule_template", "routines"), tool("link_code", "code"), tool("plugin_build", "plugins")];
const used = (name: string) => ({ block: { type: "trace", tool: name, args: {}, ok: true, summary: "", ms: 1 } }) as unknown as ThreadMessage;

it("a coding session carries its code kit; a backlog conversation carries none and keeps what it used before", () => {
  expect(carriedKits("code")).toEqual(["code"]);
  expect(deferredTools(tools, "code").map((t) => t.name)).toEqual(["create_template", "schedule_template", "plugin_build"]);
  const backlog = deferredTools(tools, "backlog", [used("schedule_template")]);
  expect(backlog.map((t) => t.name)).toEqual(["create_template", "link_code", "plugin_build"]);
  expect(kitLines(backlog, { routines: "recurring tickets" })).toEqual(["routines — recurring tickets (create_template)", "code (link_code)", "plugins (plugin_build)"]);
  expect(kitLines(backlog, { routines: "recurring tickets" }, { names: false })).toEqual(["routines — recurring tickets", "code", "plugins"]);
});
