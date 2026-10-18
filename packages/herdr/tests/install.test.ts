import { expect, it } from "vitest";
import { HERDR_GUIDE, HERDR_INSTALL, herdrInstall } from "@tomradex/herdr";

it("installs herdr with Homebrew where brew is, and offers only the install guide where it is not", () => {
  expect(herdrInstall({ brew: true })).toEqual({ command: HERDR_INSTALL, guide: HERDR_GUIDE });
  expect(HERDR_INSTALL).toBe("brew install herdr");
  expect(herdrInstall({ brew: false })).toEqual({ command: null, guide: "https://herdr.dev/docs/install/" });
});
