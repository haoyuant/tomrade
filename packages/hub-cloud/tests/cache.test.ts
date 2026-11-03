import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CloudCache } from "../src/cache.js";
import { EncryptedSessionStorage } from "../src/session.js";

const dirs: string[] = [];
function file(name = "hub.json") { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-cloud-")); dirs.push(dir); return path.join(dir, name); }
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const project = (name: string) => ({ id: "p1", name, keyPrefix: "TOM" });

describe("durable Hub outbox", () => {
  it("survives offline edits, restart, and a lost acknowledgement without changing the mutation id", () => {
    const location = file();
    const a = new CloudCache(location, "https://example.supabase.co");
    a.observe("project", "p1", project("One"));
    a.observe("project", "p1", project("Two"));
    const b = new CloudCache(location, "https://example.supabase.co");
    expect(b.data.outbox).toEqual(a.data.outbox);
    expect(b.data.outbox.map(x => x.base_version)).toEqual([0, 1]);
    const first = b.data.outbox[0];
    b.accept(first, { kind: "project", key: "p1", value: project("One"), version: 1 });
    expect(b.view()[0].value).toEqual(project("Two"));
    expect(new CloudCache(location, "https://example.supabase.co").data.outbox).toHaveLength(1);
  });
  it("does not overwrite a remote edit just because an unchanged local checkout was observed again", () => {
    const cache = new CloudCache(file(), "https://example.supabase.co");
    cache.observe("project", "p1", project("Local"));
    cache.accept(cache.data.outbox[0], { kind: "project", key: "p1", value: project("Local"), version: 1 });
    cache.ingest([{ kind: "project", key: "p1", value: project("Remote"), version: 2 }]);
    cache.observe("project", "p1", project("Local"));
    expect(cache.data.outbox).toEqual([]);
    expect(cache.view()[0].value).toEqual(project("Remote"));
    cache.observe("project", "p1", project("New local edit"));
    expect(cache.data.outbox[0].base_version).toBe(2);
  });
  it("sends a removal asked for again after another machine listed the project again, even after a restart", () => {
    const location = file();
    const a = new CloudCache(location, "https://example.supabase.co");
    a.observe("project", "p1", project("Here"));
    a.accept(a.data.outbox[0], { kind: "project", key: "p1", value: project("Here"), version: 1 });
    a.intend("project", "p1", null);
    a.accept(a.data.outbox[0], { kind: "project", key: "p1", value: null, version: 2 });
    a.ingest([{ kind: "project", key: "p1", value: project("Back"), version: 3 }]);
    const b = new CloudCache(location, "https://example.supabase.co");
    b.intend("project", "p1", null);
    expect(b.data.outbox).toMatchObject([{ kind: "project", key: "p1", value: null, base_version: 3 }]);
    // Asked while the Hub already shows it removed: nothing to send.
    b.accept(b.data.outbox[0], { kind: "project", key: "p1", value: null, version: 4 });
    b.intend("project", "p1", null);
    expect(b.data.outbox).toEqual([]);
  });
  it("retains conflicts through restart and explicitly rebases the chosen value", () => {
    const location = file();
    const cache = new CloudCache(location, "https://example.supabase.co");
    cache.observe("project", "p1", project("Local"));
    cache.observe("project", "p1", null);
    cache.conflict({ kind: "project", key: "p1", value: project("Other device"), version: 3 });
    const next = new CloudCache(location, "https://example.supabase.co");
    next.resolve("project:p1", "local");
    expect(next.data.outbox).toHaveLength(1);
    expect(next.data.outbox[0]).toMatchObject({ value: null, base_version: 3 });
    next.conflict({ kind: "project", key: "p1", value: project("Even newer"), version: 4 });
    next.resolve("project:p1", "cloud");
    expect(next.data.outbox).toEqual([]);
    expect(next.view()[0].value).toEqual(project("Even newer"));
  });
  it("pins the account and endpoint to avoid uploading one person's local Hub to another", () => {
    const location = file();
    const cache = new CloudCache(location, "https://example.supabase.co");
    cache.bind("user-a", "hub-a");
    expect(() => cache.bind("user-b", "hub-b")).toThrow(/another account/);
    expect(() => new CloudCache(location, "https://other.supabase.co")).toThrow(/another Supabase/);
  });
  it("rebases queued follow-up edits when an equivalent value already exists at a later cloud revision", () => {
    const cache = new CloudCache(file(), "https://example.supabase.co");
    cache.observe("project", "p1", project("One"));
    cache.observe("project", "p1", project("Two"));
    const [first, second] = cache.data.outbox;
    cache.accept(first, { kind: "project", key: "p1", value: project("One"), version: 5 });
    expect(cache.data.outbox[0].id).not.toBe(second.id);
    expect(cache.data.outbox[0]).toMatchObject({ base_version: 5, value: project("Two") });
  });
  it("moves a corrupt cache file aside and starts empty rather than not starting at all", () => {
    const location = file();
    fs.writeFileSync(location, "{broken");
    const warnings: string[] = [];
    const cache = new CloudCache(location, "https://example.supabase.co", (text) => warnings.push(text));
    expect(cache.data).toMatchObject({ outbox: [], records: [], userId: null });
    const kept = fs.readdirSync(path.dirname(location)).filter((n) => n.startsWith(`${path.basename(location)}.corrupt-`));
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(location), kept[0]), "utf8")).toBe("{broken");
    expect(fs.existsSync(location)).toBe(false);
    expect(warnings[0]).toMatch(/could not be read/);
    cache.observe("project", "p1", project("One"));
    expect(new CloudCache(location, "https://example.supabase.co").data.outbox).toHaveLength(1);
  });
});

it("persists sessions only through the supplied cipher and refuses unavailable secure storage", () => {
  const location = file("account.enc");
  const cipher = { available: () => true, encrypt: (v: string) => Buffer.from(v).reverse(), decrypt: (v: Buffer) => Buffer.from(v).reverse().toString() };
  const store = new EncryptedSessionStorage(location, cipher);
  store.setItem("session", "private-refresh-token");
  expect(fs.readFileSync(location, "utf8")).not.toContain("private-refresh-token");
  expect(new EncryptedSessionStorage(location, cipher).getItem("session")).toBe("private-refresh-token");
  store.setItem("verifier", "one-time");
  store.removeItem("session");
  expect(store.getItem("session")).toBeNull();
  expect(store.getItem("verifier")).toBe("one-time");
  const unavailable = new EncryptedSessionStorage(file(), { ...cipher, available: () => false });
  expect(() => unavailable.setItem("session", "secret")).toThrow(/unavailable/);
});
