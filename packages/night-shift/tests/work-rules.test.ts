import { describe, expect, it } from "vitest";
import type { Item } from "@tomradex/domain";
import { ruleConfig, ruleFor, type WorkRule } from "@tomradex/night-shift";

const item = (over: Partial<Item> = {}): Item => ({ id: "A", key: "A", title: "Fix the Export button", kind: "ticket", workType: "coding", status: "todo", priority: 2, labels: ["docs"], ...over }) as Item;
const rule = (name: string, when: WorkRule["when"], then: WorkRule["then"] = {}): WorkRule => ({ id: name, name, when, then });

describe("which rule a ticket falls under", () => {
  it("matches on label, whatever its case", () => expect(ruleFor([rule("r", { label: "DOCS" })], item())?.name).toBe("r"));
  it("matches on a word in the title", () => expect(ruleFor([rule("r", { titleHas: "export" })], item())?.name).toBe("r"));
  it("matches on work type", () => {
    expect(ruleFor([rule("r", { workType: "general" })], item())).toBeNull();
    expect(ruleFor([rule("r", { workType: "coding" })], item())?.name).toBe("r");
  });
  it("matches on priority and above", () => {
    expect(ruleFor([rule("r", { minPriority: 2 })], item())?.name).toBe("r");
    expect(ruleFor([rule("r", { minPriority: 3 })], item())).toBeNull();
  });
  it("wants every condition it sets", () => expect(ruleFor([rule("r", { label: "docs", minPriority: 4 })], item())).toBeNull());
  it("takes the first that matches, so order is rank", () => {
    expect(ruleFor([rule("first", { label: "docs" }), rule("second", { label: "docs" })], item())?.name).toBe("first");
  });
  it("a rule with no condition, or only blanks, matches nothing", () => {
    expect(ruleFor([rule("r", {})], item())).toBeNull();
    expect(ruleFor([rule("r", { label: "  ", titleHas: "" })], item())).toBeNull();
  });
});

describe("what a rule sets", () => {
  it("is what it names and no more; leaving out is not a setting", () => {
    expect(ruleConfig(rule("r", {}, { skip: true }))).toEqual({});
    expect(ruleConfig(rule("r", {}, { engine: "e", autoMerge: false }))).toEqual({ engine: "e", autoMerge: false });
  });
});
