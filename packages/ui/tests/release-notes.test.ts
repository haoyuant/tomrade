import { expect, it } from "vitest";
import { releaseNotes } from "../src/lib/updates";

const notes = "## en\n- Faster starts\n- Fixed a crash on quit\n\n## zh\n- 启动更快\n- 修复了退出时的崩溃\n";

it("reads a release's notes in the reader's language, Chinese for both scripts and English for the rest", () => {
  expect(releaseNotes(notes, "en")).toEqual(["Faster starts", "Fixed a crash on quit"]);
  expect(releaseNotes(notes, "zh")).toEqual(["启动更快", "修复了退出时的崩溃"]);
  expect(releaseNotes(notes, "zhHant")).toEqual(["启动更快", "修复了退出时的崩溃"]);
  expect(releaseNotes(notes, "ja")).toEqual(["Faster starts", "Fixed a crash on quit"]);
  // A language the release did write is its own.
  expect(releaseNotes(`${notes}\n## zh-Hant\n- 啟動更快\n`, "zhHant")).toEqual(["啟動更快"]);
  expect(releaseNotes("## zh\n- 只有中文\n", "en")).toEqual(["只有中文"]);
});

it("reads notes with no language headings whole, and nothing from none", () => {
  expect(releaseNotes("- Faster starts\n* Fewer prompts\nA plain line\n\n", "zh")).toEqual(["Faster starts", "Fewer prompts", "A plain line"]);
  expect(releaseNotes(null, "en")).toEqual([]);
  expect(releaseNotes("  \n", "en")).toEqual([]);
});
