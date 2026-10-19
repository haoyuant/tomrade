import { describe, expect, it } from "vitest";
import * as sdk from "@tomradex/plugin-sdk";
import { SDK_CONTRACT, SDK_EXPORTS, compareVersions, lowestContract } from "@tomradex/plugin-sdk";

describe("when each SDK export shipped", () => {
  it("lists every value the SDK exports, none later than this contract", () => {
    // A new export fails here until it is listed under the contract it ships in.
    expect(Object.keys(SDK_EXPORTS).sort()).toEqual(Object.keys(sdk).sort());
    for (const [name, since] of Object.entries(SDK_EXPORTS)) expect(compareVersions(since, SDK_CONTRACT), name).toBeLessThanOrEqual(0);
    expect(SDK_EXPORTS.definePlugin).toBe("0.2.0");
    expect(SDK_EXPORTS.wordsFor).toBe("0.2.9");
  });

  it("finds the oldest contract a range accepts", () => {
    expect(lowestContract("^0.2.6")).toBe("0.2.6");
    expect(lowestContract(">=0.2.2 <0.3.0")).toBe("0.2.2");
    expect(lowestContract(`^${SDK_CONTRACT}`)).toBe(SDK_CONTRACT);
    expect(lowestContract("^0.3.0")).toBeNull();
  });
});
