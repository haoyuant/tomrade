import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, MAX_IMAGE_BYTES, PET_MOODS, sniffImage } from "@tomradex/pet";
import { PetProfiles } from "../src/profiles.js";

const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
const builtIn = Object.fromEntries(PET_MOODS.map((m) => [m, { path: `/pkg/assets/${m}.webp`, type: "image/webp" }])) as ConstructorParameters<typeof PetProfiles>[1];

const dirs: string[] = [];
const store = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-profiles-"));
  dirs.push(dir);
  return { dir, profiles: new PetProfiles(dir, builtIn) };
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("pet profiles", () => {
  it("reads image types from their bytes", () => {
    expect(sniffImage(GIF)).toBe("image/gif");
    expect(sniffImage(PNG)).toBe("image/png");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))).toBeNull();
  });

  it("without a local folder only the built-in pet exists", () => {
    const profiles = new PetProfiles(null, builtIn);
    expect(profiles.view()).toEqual({
      active: DEFAULT_PROFILE,
      canSave: false,
      moods: ["idle", "thinking", "working", "waiting", "success", "error"],
      maxImageBytes: MAX_IMAGE_BYTES,
      profiles: [{ id: DEFAULT_PROFILE, name: "", builtIn: true, pixelated: false, custom: [] }]
    });
    expect(() => profiles.create("Mine")).toThrow(/No local folder/);
    expect(profiles.resolve(DEFAULT_PROFILE).idle).toEqual({ path: "/pkg/assets/idle.webp", type: "image/webp", pixelated: false, custom: false });
  });

  it("a profile shows its own images and the built-in pet's for the rest", () => {
    const { dir, profiles } = store();
    const mine = profiles.create("  Mochi  ");
    expect(mine.name).toBe("Mochi");
    profiles.setImage(mine.id, "working", { base64: GIF.toString("base64"), box: { x: 0, y: 0, width: 1, height: 1 } });
    profiles.update(mine.id, { pixelated: true });
    profiles.activate(mine.id);

    const view = profiles.view();
    expect(view.active).toBe(mine.id);
    expect(view.profiles.map((p) => [p.id, p.builtIn, p.custom])).toEqual([[DEFAULT_PROFILE, true, []], [mine.id, false, ["working"]]]);
    const images = profiles.resolve(mine.id);
    expect(images.working).toMatchObject({ type: "image/gif", box: { x: 0, y: 0, width: 1, height: 1 }, pixelated: true, custom: true });
    expect(fs.readFileSync(images.working.path)).toEqual(GIF);
    expect(path.dirname(images.working.path)).toBe(path.join(dir, mine.id));
    expect(images.idle).toMatchObject({ path: "/pkg/assets/idle.webp", pixelated: false, custom: false });

    // A replacement is a new file; the old one is gone.
    const first = images.working.path;
    profiles.setImage(mine.id, "working", { base64: WEBP.toString("base64") });
    const replaced = profiles.resolve(mine.id).working;
    expect(replaced).toMatchObject({ type: "image/webp", custom: true });
    expect(replaced.box).toBeUndefined();
    expect(fs.existsSync(first)).toBe(false);

    profiles.clearImage(mine.id, "working");
    expect(profiles.resolve(mine.id).working.custom).toBe(false);
    expect(fs.readdirSync(path.join(dir, mine.id))).toEqual(["profile.json"]);
  });

  it("refuses what is not an image, too big, or the built-in pet", () => {
    const { profiles } = store();
    const mine = profiles.create("Mine");
    expect(() => profiles.setImage(mine.id, "idle", { base64: Buffer.from("<svg/>").toString("base64") })).toThrow(/GIF, WebP/);
    expect(() => profiles.setImage(mine.id, "idle", { base64: Buffer.concat([GIF, Buffer.alloc(MAX_IMAGE_BYTES)]).toString("base64") })).toThrow(/at most/);
    expect(() => profiles.setImage(mine.id, "nap" as never, { base64: GIF.toString("base64") })).toThrow(/Unknown pet state/);
    expect(() => profiles.setImage(DEFAULT_PROFILE, "idle", { base64: GIF.toString("base64") })).toThrow(/built-in/);
    expect(() => profiles.update(DEFAULT_PROFILE, { name: "Renamed" })).toThrow(/built-in/);
    expect(() => profiles.remove(DEFAULT_PROFILE)).toThrow(/built-in/);
    expect(() => profiles.create("   ")).toThrow(/name/);
    expect(() => profiles.activate("../escape")).toThrow(/No pet/);
    // A box that is not whole pixels is dropped, not trusted.
    profiles.setImage(mine.id, "idle", { base64: GIF.toString("base64"), box: { x: -1, y: 0, width: 1.5, height: 1 } });
    expect(profiles.resolve(mine.id).idle.box).toBeUndefined();
  });

  it("removing the active pet returns to the built-in one", () => {
    const { profiles } = store();
    const mine = profiles.create("Mine");
    profiles.activate(mine.id);
    profiles.remove(mine.id);
    expect(profiles.view().active).toBe(DEFAULT_PROFILE);
    expect(profiles.view().profiles).toHaveLength(1);
  });
});
