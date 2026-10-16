import { expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
import { parseDeepLink } from "../src/deep-link.js";

it("reads the links IM replies carry, and nothing else", () => {
  expect(parseDeepLink("tomrade://item/p%201/TOM-12")).toEqual({ kind: "item", projectId: "p 1", ref: "TOM-12" });
  expect(parseDeepLink("tomrade://thread/p1/t-9")).toEqual({ kind: "thread", projectId: "p1", ref: "t-9" });
  expect(parseDeepLink("tomrade://file/p1/f%2Fx")).toEqual({ kind: "file", projectId: "p1", ref: "f/x" });
  for (const bad of ["https://item/p1/TOM-1", "tomrade://view/p1/x", "tomrade://item/p1", "tomrade://item/p1/a/b", "tomrade://item/p1/%E0%A4%A", "not a url"]) {
    expect(parseDeepLink(bad)).toBeNull();
  }
});
