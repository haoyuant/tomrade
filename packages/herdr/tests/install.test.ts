import { expect, it } from "vitest";
import { HERDR_GUIDE, HERDR_INSTALL, HERDR_SCRIPT_INSTALL, herdrInstall } from "@tomradex/herdr";

it("installs herdr with Homebrew where brew is, with herdr's installer on other Macs and Linux, and offers only the guide elsewhere", () => {
  expect(herdrInstall({ brew: true })).toEqual({ command: HERDR_INSTALL, guide: HERDR_GUIDE });
  expect(HERDR_INSTALL).toBe("brew install herdr");
  expect(herdrInstall({ brew: false, platform: "darwin" })).toEqual({ command: "curl -fsSL https://herdr.dev/install.sh | sh", guide: HERDR_GUIDE });
  expect(herdrInstall({ brew: false, platform: "linux" })).toEqual({ command: HERDR_SCRIPT_INSTALL, guide: HERDR_GUIDE });
  expect(herdrInstall({ brew: false, platform: "win32" })).toEqual({ command: null, guide: "https://herdr.dev/docs/install/" });
});
