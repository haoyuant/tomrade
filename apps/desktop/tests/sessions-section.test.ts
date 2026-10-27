import { expect, it } from "vitest";
import { SESSIONS_SECTION } from "../src/sessions-section.js";

it("sets the session bar by width and peeking on until the person says otherwise, in both languages", () => {
  const parsed = SESSIONS_SECTION.schema.parse({});
  expect(parsed).toEqual(SESSIONS_SECTION.defaults);
  expect(parsed).toMatchObject({ sessionBar: "auto", peek: true });
  expect(SESSIONS_SECTION.schema.parse({ sessionBar: "cards", peek: false })).toMatchObject({ sessionBar: "cards", peek: false });
  expect(() => SESSIONS_SECTION.schema.parse({ sessionBar: "wide" })).toThrow();
  const zh = SESSIONS_SECTION.words!.zh!.fields!;
  expect(zh.sessionBar).toMatchObject({ title: "会话栏", options: { auto: "按宽度", rail: "总是收起", cards: "总是展开" } });
  expect(zh.peek?.title).toBe("收起时悬停偷看");
  expect(SESSIONS_SECTION.words!.en!.fields!.sessionBar!.options).toEqual({ auto: "By width", rail: "Always folded", cards: "Always unfolded" });
});
