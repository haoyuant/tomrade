import { expect, it } from "vitest";
import { execGit } from "../src/index.js";

it.runIf(process.platform === "win32")("lets git on Windows take paths past 260 characters, a store's pack under a person's data folder among them", async () => {
  const { stdout } = await execGit("git", ["config", "--get", "core.longpaths"]);
  expect(stdout.trim()).toBe("true");
});
