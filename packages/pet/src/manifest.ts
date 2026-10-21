import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AccessoryAnimation, AssistantAccessory } from "@tomradex/contributions";
import type { ResolvedImage } from "./profiles.js";
import { PET_MOODS, type PetMood } from "./state.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PET_ASSET_DIR = path.join(packageDir, "assets");
export const PET_DESKTOP_URL = pathToFileURL(path.join(PET_ASSET_DIR, "desktop.html")).href;

/** The built-in pet: memes cropped to their content, each keeping its own frame timings. */
export const BUILT_IN_IMAGES = Object.fromEntries(
  PET_MOODS.map((mood) => [mood, { path: path.join(PET_ASSET_DIR, `${mood}.webp`), type: "image/webp" }])
) as Record<PetMood, { path: string; type: string }>;

const animation = (image: ResolvedImage, source: string): AccessoryAnimation => ({
  source,
  type: image.type,
  ...(image.box ? { box: image.box } : {}),
  ...(image.pixelated ? { pixelated: true } : {})
});

/** Data URLs work in both the packaged file renderer and Vite's development origin. */
export const dataAnimation = (image: ResolvedImage) => animation(image, `data:${image.type};base64,${fs.readFileSync(image.path).toString("base64")}`);

/** The desktop surface is a file document and reads the images where they are. */
export const fileAnimation = (image: ResolvedImage) => animation(image, pathToFileURL(image.path).href);

export function embeddedAccessory(images: Record<PetMood, ResolvedImage>): AssistantAccessory {
  return {
    id: "tomrade.pet",
    kind: "animated-pet",
    title: "Tomrade pet",
    stateChannel: "pet.state",
    changedChannel: "pet.changed",
    width: 151,
    height: 120,
    animations: Object.fromEntries(PET_MOODS.map((mood) => [mood, dataAnimation(images[mood])]))
  };
}
