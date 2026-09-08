import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AssistantAccessory, SpriteAnimation } from "@tomrade/contributions";
import type { PetMood } from "./state.js";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PET_ASSET_DIR = path.join(packageDir, "assets");
export const PET_DESKTOP_URL = pathToFileURL(path.join(PET_ASSET_DIR, "desktop.html")).href;

interface AssetAnimation extends SpriteAnimation {
  file: string;
}

export const PET_ANIMATIONS: Record<PetMood, AssetAnimation> = {
  idle: { file: "cat-idle-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 360 },
  thinking: { file: "cat-thinking-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 210 },
  working: { file: "cat-working-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 150 },
  waiting: { file: "cat-waiting-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 420 },
  success: { file: "cat-success-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 190 },
  error: { file: "cat-error-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 280 },
  walk: { file: "cat-walk-strip.png", source: "", frames: 4, frameWidth: 352, frameHeight: 280, frameMs: 140 }
};

let accessory: AssistantAccessory | undefined;

/** Data URLs work in both the packaged file renderer and Vite's development origin. */
export function embeddedAccessory(): AssistantAccessory {
  if (accessory) return accessory;
  const animations = Object.fromEntries(
    Object.entries(PET_ANIMATIONS).map(([mood, animation]) => {
      const { file, ...view } = animation;
      return [mood, { ...view, source: `data:image/png;base64,${fs.readFileSync(path.join(PET_ASSET_DIR, file)).toString("base64")}` }];
    })
  );
  accessory = {
    id: "tomrade.pet",
    kind: "sprite-pet",
    title: "Tomrade pet",
    stateChannel: "pet.state",
    changedChannel: "pet.changed",
    width: 151,
    height: 120,
    animations
  };
  return accessory;
}

export function desktopAnimation(mood: PetMood) {
  const animation = PET_ANIMATIONS[mood];
  return { source: animation.file, frames: animation.frames, frameWidth: animation.frameWidth, frameHeight: animation.frameHeight, frameMs: animation.frameMs };
}
