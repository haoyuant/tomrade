import { expect, it } from "vitest";
import { isBuiltinLayout, isPluginLayout, parseLayout, pluginLayout, pluginLayoutId } from "@tomradex/domain";

it("tells the built-in layouts from a plugin's, and reads a stored layout back as a board only when it is neither", () => {
  expect(["board", "table", "graph"].every(isBuiltinLayout)).toBe(true);
  expect(isBuiltinLayout("plugin:demo.timeline")).toBe(false);
  expect(isPluginLayout("plugin:demo.timeline")).toBe(true);
  expect(isPluginLayout("plugin:")).toBe(false);
  expect(pluginLayout("demo.timeline")).toBe("plugin:demo.timeline");
  expect(pluginLayoutId("plugin:demo.timeline")).toBe("demo.timeline");
  expect(parseLayout("graph")).toBe("graph");
  expect(parseLayout("plugin:demo.timeline")).toBe("plugin:demo.timeline");
  expect(parseLayout("calendar")).toBe("board");
});
