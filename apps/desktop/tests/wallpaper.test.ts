import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const opened = vi.hoisted(() => [] as string[]);
vi.mock("electron", () => ({
  nativeImage: {
    createFromPath: (file: string) => {
      opened.push(file);
      const pixels = Buffer.alloc(64 * 36 * 4, 200);
      const small = { getSize: () => ({ width: 64, height: 36 }), toBitmap: () => pixels };
      return { isEmpty: () => false, resize: () => small };
    },
    createFromBitmap: () => ({ toDataURL: () => "data:image/png;base64,soft" })
  }
}));

const { wallpaperRoom } = await import("../src/wallpaper.js");

let dir: string;
const env = { ...process.env };
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "tomrade-wallpaper-"));
  opened.length = 0;
  process.env.XDG_CONFIG_HOME = dir;
  process.env.XDG_CURRENT_DESKTOP = "KDE";
});
afterEach(() => {
  process.env = { ...env };
  fs.rmSync(dir, { recursive: true, force: true });
});

const plasma = (image: string) =>
  fs.writeFileSync(path.join(dir, "plasma-org.kde.plasma.desktop-appletsrc"), `[Containments][1]\nplugin=org.kde.desktopcontainment\n\n[Containments][1][Wallpaper][org.kde.image][General]\nImage=${image}\n`);

describe("Glass's wallpaper room", () => {
  it("softens the picture Plasma's desktop names", async () => {
    const picture = path.join(dir, "lake.jpg");
    fs.writeFileSync(picture, "");
    plasma(`file://${picture}`);
    expect(await wallpaperRoom()).toBe("data:image/png;base64,soft");
    expect(opened).toEqual([picture]);
  });

  it("takes the largest picture of a wallpaper package", async () => {
    const images = path.join(dir, "Mountain/contents/images");
    fs.mkdirSync(images, { recursive: true });
    for (const name of ["1280x800.png", "5120x2880.png", "1920x1080.jpg", "screenshot.svg"]) fs.writeFileSync(path.join(images, name), "");
    plasma(path.join(dir, "Mountain"));
    await wallpaperRoom();
    expect(opened).toEqual([path.join(images, "5120x2880.png")]);
  });

  it("has none on a desktop it can't ask", async () => {
    process.env.XDG_CURRENT_DESKTOP = "XFCE";
    expect(await wallpaperRoom()).toBeNull();
    expect(opened).toEqual([]);
  });
});
