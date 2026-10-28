import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import type { Project } from "@tomradex/domain";
import { CAPABILITIES, capabilityLink, mediaOf, projectToTry, showsOnHome } from "../src/lib/capabilities";
import { en, zh } from "../src/lib/i18n-messages";

const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, description: null, keyPrefix: "T", archived: false, createdAt: 0, updatedAt: 0, ...over });
const message = (dict: typeof en, key: string) => key.split(".").reduce<unknown>((at, part) => (at as Record<string, unknown> | undefined)?.[part], dict);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));

it("lands each card's Try it where its use begins", () => {
  expect(Object.fromEntries(CAPABILITIES.map((c) => [c.id, c.action]))).toEqual({
    idea: { kind: "fill", prompt: "agentPanel.starterIdeaPrompt" },
    terminal: { kind: "agentConnection" },
    sessions: { kind: "startPalette" },
    groom: { kind: "fill", prompt: "agentPanel.starterGroomPrompt" },
    im: { kind: "imSettings" }
  });
});

it("has every card's words in English and Chinese, and a still for both", () => {
  for (const c of CAPABILITIES) {
    for (const key of [c.title, c.line, ...(c.action.kind === "fill" ? [c.action.prompt] : [])]) {
      expect(message(en, key), key).toBeTypeOf("string");
      expect(message(zh, key), key).toBeTypeOf("string");
    }
    for (const locale of ["en", "zh"] as const) {
      const media = mediaOf(c, locale, publicDir);
      expect(existsSync(media.poster), media.poster).toBe(true);
      if (media.video) expect(existsSync(media.video), media.video).toBe(true);
    }
  }
});

it("plays the English clip in every language but Chinese", () => {
  const idea = CAPABILITIES[0]!;
  expect(mediaOf(idea, "zh", "./").poster).toBe("./capabilities/idea-zh.webp");
  expect(mediaOf(idea, "zh-Hant", "./").poster).toBe("./capabilities/idea-zh.webp");
  expect(mediaOf(idea, "de", "./").poster).toBe("./capabilities/idea-en.webp");
  expect(mediaOf({ ...idea, video: false }, "en", "./").video).toBeNull();
  expect(mediaOf({ ...idea, video: true }, "en", "./").video).toBe("./capabilities/idea-en.webm");
});

it("shows the cards on the home while there are few projects in use", () => {
  expect(showsOnHome([])).toBe(true);
  expect(showsOnHome([project("a"), project("b"), project("c")])).toBe(true);
  expect(showsOnHome([project("a"), project("b"), project("c"), project("d")])).toBe(false);
  expect(showsOnHome([project("a"), project("b"), project("c"), project("d", { archived: true })])).toBe(true);
});

it("tries in the open project, else the first in use before the sample", () => {
  const list = [project("sample", { sample: true }), project("old", { archived: true }), project("mine")];
  expect(projectToTry(list, "sample")).toBe("sample");
  expect(projectToTry(list, null)).toBe("mine");
  expect(projectToTry(list, "old")).toBe("mine");
  expect(projectToTry([project("sample", { sample: true })], null)).toBe("sample");
  expect(projectToTry([], null)).toBeNull();
});

it("reads an announcement's link to the page or one of its cards", () => {
  expect(capabilityLink("#capabilities")).toEqual({ focus: null });
  expect(capabilityLink("#capabilities/im")).toEqual({ focus: "im" });
  expect(capabilityLink("#capabilities/nope")).toEqual({ focus: null });
  expect(capabilityLink("https://tomrade.com/#capabilities")).toBeNull();
  expect(capabilityLink("#other")).toBeNull();
});
