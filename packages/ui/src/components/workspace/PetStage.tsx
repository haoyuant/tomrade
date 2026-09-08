import type { CSSProperties } from "react";
import type { AssistantAccessory } from "@tomrade/contributions";
import { useAccessoryState } from "~/lib/pet";

export function PetStage({ accessory, threadId }: { accessory: AssistantAccessory; threadId: string | null }) {
  const pet = useAccessoryState(accessory, threadId);
  const mood = pet.data?.mood ?? "idle";
  const animation = accessory.animations[mood] ?? accessory.animations.idle;
  if (!animation) return null;
  const style = {
    width: accessory.width,
    height: accessory.height,
    backgroundImage: `url(${JSON.stringify(animation.source)})`,
    backgroundSize: `${accessory.width * animation.frames}px ${accessory.height}px`,
    "--pet-duration": `${animation.frameMs * animation.frames}ms`,
    "--pet-travel": `${-accessory.width * animation.frames}px`,
    "--pet-frame-count": String(animation.frames),
    "--pet-iterations": animation.loop === false ? "1" : "infinite"
  } as CSSProperties;
  return (
    <div className="pet-stage" data-pet-state={mood}>
      <span className="pet-sprite" style={style} role="img" aria-label={`${accessory.title}: ${mood}`} />
    </div>
  );
}
