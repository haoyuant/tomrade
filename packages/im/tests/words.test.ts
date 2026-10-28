import { describe, expect, it } from "vitest";
import { activityText, toolLine } from "../src/rich.js";
import { IM_WORDS } from "../src/words.js";

describe("progress in words", () => {
  const en = IM_WORDS("en");
  const zh = IM_WORDS("zh");

  it("says what tools do, whatever server an engine names them by, without repeats or bookkeeping", () => {
    const tools = ["ToolSearch", "mcp__tomrade__find_similar", "tomrade.create_item", "start_ticket", "list_repos", "Bash", "Bash"].map(tool => ({ tool, ok: true }));
    expect(toolLine(en, tools)).toBe("… Creating the ticket · Starting the work · Looking up the project · Running a command");
    expect(toolLine(zh, tools.slice(0, 3))).toBe("在查有没有重复的工单 · 在建工单");
    expect(toolLine(en, [{ tool: "some_plugin_tool", ok: false }])).toBe("Using tools");
  });

  it("puts an activity that names a tool in words, and keeps one already in words", () => {
    expect(activityText(en, "Bash · git status")).toBe("Running a command");
    expect(activityText(en, "shell · ls")).toBe("Running a command");
    expect(activityText(en, "SomeNewTool")).toBe("Using tools");
    expect(activityText(en, "reading the backlog")).toBe("reading the backlog");
    expect(activityText(en, "thinking")).toBe("thinking");
  });
});
