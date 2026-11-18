import { useEffect } from "react";
import type { AssistantAccessory } from "@tomradex/contributions";
import { reportAction } from "~/lib/analytics";
import { useAccessoryState } from "~/lib/pet";
import { PetCanvas } from "./PetCanvas";

export function PetStage({ accessory, threadId }: { accessory: AssistantAccessory; threadId: string | null }) {
  const pet = useAccessoryState(accessory, threadId);
  useEffect(() => reportAction("pet.companion", "open"), []);
  const mood = pet.data?.mood ?? "idle";
  const animation = accessory.animations[mood] ?? accessory.animations.idle;
  if (!animation) return null;
  return (
    <div className="pet-stage" data-pet-state={mood} onClick={() => reportAction("pet.companion", "interact")}>
      <PetCanvas className="pet-canvas" animation={animation} width={accessory.width} height={accessory.height} label={`${accessory.title}: ${mood}`} />
    </div>
  );
}
