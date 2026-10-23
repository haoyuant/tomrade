import { describe, expect, it } from "vitest";
import { tokens } from "../src/components/workspace/agent-panel/format";

describe("tokens", () => {
  it("stays exact below a thousand", () => {
    expect(tokens(0)).toBe("0");
    expect(tokens(999)).toBe("999");
  });

  it("reads in thousands", () => {
    expect(tokens(1_234)).toBe("1.2k");
    expect(tokens(12_345)).toBe("12k");
    expect(tokens(999_499)).toBe("999k");
  });

  it("steps up to millions instead of printing 1000k", () => {
    expect(tokens(999_500)).toBe("1.0M");
    expect(tokens(1_234_567)).toBe("1.2M");
  });
});
