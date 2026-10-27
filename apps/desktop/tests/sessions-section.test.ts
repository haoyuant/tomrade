import { expect, it } from "vitest";
import { SESSIONS_SECTION } from "../src/sessions-section.js";

it("runs new sessions in a background pane unless the person asks for the Terminal window too", () => {
  expect(SESSIONS_SECTION.schema.parse({}).newWhere).toBe("pane");
  expect(SESSIONS_SECTION.schema.parse({ newWhere: "window" }).newWhere).toBe("window");
  expect(() => SESSIONS_SECTION.schema.parse({ newWhere: "elsewhere" })).toThrow();
  expect(SESSIONS_SECTION.words?.zh?.fields?.newWhere).toMatchObject({ title: "新会话在哪里跑", options: { pane: "后台窗格", window: "也打开终端窗口" } });
});
