import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("electron", () => ({ app: {} }));
import { AccountFolders } from "../src/accounts.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function machine() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-accounts-"));
  dirs.push(root);
  const roots = { userData: path.join(root, "app-data"), tomradeDir: path.join(root, "Tomrade") };
  return { roots, folders: new AccountFolders(roots) };
}
const ada = { id: "user-ada", email: "Ada@Example.com" };
const bea = { id: "user-bea", email: "bea+work@example.com" };

it("keeps the first account in the original folders and gives every other one its own", () => {
  const { roots, folders } = machine();
  expect(folders.active).toBeNull();
  expect(folders.dirs(null)).toEqual({ userData: roots.userData, hubDir: roots.tomradeDir });
  folders.claim(ada, null);
  expect(folders.elsewhere(ada.id, null)).toBe(false);
  expect(folders.elsewhere(bea.id, null)).toBe(false);

  const folder = folders.folderFor(bea);
  expect(folder).toBe("bea+work@example.com");
  folders.activate(bea, folder);
  expect(folders.active).toBe(folder);
  expect(folders.dirs(folder)).toEqual({ userData: path.join(roots.userData, "accounts", folder!), hubDir: path.join(roots.tomradeDir, "accounts", folder!) });
  expect(folders.folderAt(folders.dirs(folder).userData)).toBe(folder);
  expect(folders.folderAt(roots.userData)).toBeNull();
  expect(folders.folderAt(path.join(roots.userData, "elsewhere"))).toBeUndefined();

  // From Bea's folder, Ada is elsewhere and goes back to the original one.
  expect(folders.elsewhere(ada.id, folder)).toBe(true);
  expect(folders.folderFor(ada)).toBeNull();
  folders.activate(ada, null);
  expect(folders.active).toBeNull();
  expect(new AccountFolders(roots).folderFor(bea)).toBe(folder);
});

it("never names a new account's folder after one already taken or left on disk", () => {
  const { folders } = machine();
  fs.mkdirSync(folders.dirs("ada@example.com").hubDir, { recursive: true });
  expect(folders.folderFor(ada)).toBe("ada@example.com-2");
  folders.activate(ada, "ada@example.com-2");
  expect(folders.folderFor({ id: "user-ada-again", email: "ada@example.com" })).toBe("ada@example.com-3");
  expect(folders.folderFor({ id: "user-dots", email: "../.." })).toBe("_..");
});

it("lets a folder belong to one account at a time", () => {
  const { folders } = machine();
  folders.claim(ada, null);
  folders.claim(bea, null);
  expect(folders.elsewhere(ada.id, "x")).toBe(false);
  expect(folders.folderFor(ada)).not.toBeNull();
});

it("forgets a deleted account, so its folder goes to whoever signs in there next", () => {
  const { folders } = machine();
  folders.claim(ada, null);
  const folder = folders.folderFor(bea);
  folders.activate(bea, folder);
  folders.forget(bea.id);
  expect(folders.elsewhere(bea.id, null)).toBe(false);
  expect(folders.active).toBe(folder);
  expect(folders.folderFor(ada)).toBeNull();
  folders.forget(ada.id);
  folders.claim(bea, null);
  expect(folders.folderFor(bea)).toBeNull();
});
