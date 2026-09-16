import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { AgentMediaStore } from "../src/media.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-media-test-"));
  directories.push(root);
  return { root, store: new AgentMediaStore(root) };
}
it("persists the exact bytes across restart and isolates project/thread references", () => {
  const { root, store } = setup();
  const base64 = Buffer.from("<html>diagram</html>").toString("base64");
  const ref = store.add("project", "thread", { name: "diagram.html", mime: "text/html", base64 });
  expect(new AgentMediaStore(root).read("project", "thread", ref.id)).toEqual({ ...ref, base64 });
  expect(() => store.read("other", "thread", ref.id)).toThrow();
  expect(() => store.read("project", "other", ref.id)).toThrow();
  expect(() => store.read("project", "thread", "../../secret")).toThrow("Invalid media reference");
});
it("provides an extension-bearing immutable copy for local image CLIs", () => {
  const { store } = setup();
  const ref = store.add("p", "t", { name: "x.png", mime: "image/png", base64: "YWJj" });
  const filename = store.localPath("p", "t", ref.id);
  expect(filename).toMatch(/\.png$/);
  expect(fs.readFileSync(filename).toString()).toBe("abc");
  expect(store.localPath("p", "t", ref.id)).toBe(filename);
});
it("rejects malformed payloads and unsupported media before writing", () => {
  const { root, store } = setup();
  expect(() => store.add("p", "t", { name: "image.png", mime: "image/png", base64: "%%%" })).toThrow();
  expect(() => store.add("p", "t", { name: "program.js", mime: "application/javascript", base64: "YWJj" })).toThrow();
  expect(fs.readdirSync(root)).toEqual([]);
});
