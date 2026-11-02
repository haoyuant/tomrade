import { expect, it } from "vitest";
import { rollupChecks } from "@tomradex/code-link";

const run = (status: string, conclusion: string | null = null) => ({ status, conclusion });

it("reads gh's check rollup in one word", () => {
  expect(rollupChecks([])).toBe("none");
  expect(rollupChecks([run("COMPLETED", "SUCCESS"), run("COMPLETED", "SKIPPED")])).toBe("passed");
  expect(rollupChecks([run("COMPLETED", "SUCCESS"), run("IN_PROGRESS")])).toBe("pending");
  expect(rollupChecks([{ state: "PENDING" }])).toBe("pending");
  expect(rollupChecks([run("IN_PROGRESS"), run("COMPLETED", "FAILURE")])).toBe("failed");
  expect(rollupChecks([{ state: "ERROR" }])).toBe("failed");
  expect(rollupChecks([{ state: "SUCCESS" }])).toBe("passed");
});
