import type { AssistantAccessory } from "@tomradex/contributions";
import { useCallback, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";
import { useAccessoryState } from "~/lib/pet";
import {
  PET_MAX_ZOOM,
  PET_MIN_ZOOM,
  PET_STAGE_KEY,
  heightFromDrag,
  parsePetStage,
  petDrawScale,
  petStageDefault,
  serializePetStage,
  stepZoom,
  type PetStageGeometry
} from "~/lib/petStage";
import { PetCanvas } from "./PetCanvas";

export function PetStage({ accessory, threadId }: { accessory: AssistantAccessory; threadId: string | null }) {
  const { t } = useI18n();
  const pet = useAccessoryState(accessory, threadId);
  const [geometry, setGeometry] = useState<PetStageGeometry>(() => parsePetStage(localStorage.getItem(PET_STAGE_KEY), accessory.height));
  // The drag reads the latest geometry without re-binding its listeners every frame.
  const current = useRef(geometry);

  const remember = useCallback((patch: Partial<PetStageGeometry>) => {
    const next = { height: patch.height ?? current.current.height, zoom: patch.zoom ?? current.current.zoom };
    current.current = next;
    setGeometry(next);
    localStorage.setItem(PET_STAGE_KEY, serializePetStage(next));
  }, []);

  const startResize = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = current.current.height;
      document.body.style.userSelect = "none";
      document.body.style.cursor = "ns-resize";
      // The handle sits on the bottom edge: dragging down makes the zone taller.
      const onMove = (e: MouseEvent) => remember({ height: heightFromDrag(startHeight, e.clientY - startY) });
      const onUp = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [remember]
  );

  const mood = pet.data?.mood ?? "idle";
  const animation = accessory.animations[mood] ?? accessory.animations.idle;
  if (!animation) return null;
  const scale = petDrawScale(geometry, accessory.height);
  const percent = Math.round(geometry.zoom * 100);
  return (
    <div className="pet-stage" data-pet-state={mood} style={{ height: geometry.height }}>
      <div className="pet-stage-pet">
        <PetCanvas
          className="pet-canvas"
          animation={animation}
          width={Math.round(accessory.width * scale)}
          height={Math.round(accessory.height * scale)}
          label={`${accessory.title}: ${mood}`}
        />
      </div>
      <div className="pet-stage-tools">
        <button
          type="button"
          className="btn btn-icon"
          title={t("agentPanel.petZoomOut")}
          aria-label={t("agentPanel.petZoomOut")}
          disabled={geometry.zoom <= PET_MIN_ZOOM}
          onClick={() => remember({ zoom: stepZoom(geometry.zoom, -1) })}
        >
          <Icon name="i-shrink" size={12} />
        </button>
        <button
          type="button"
          className="pet-zoom-label"
          title={t("agentPanel.petZoomReset")}
          aria-label={t("agentPanel.petZoomReset")}
          onDoubleClick={() => remember({ zoom: PET_MIN_ZOOM })}
        >
          {t("agentPanel.petZoom", { percent: String(percent) })}
        </button>
        <button
          type="button"
          className="btn btn-icon"
          title={t("agentPanel.petZoomIn")}
          aria-label={t("agentPanel.petZoomIn")}
          disabled={geometry.zoom >= PET_MAX_ZOOM}
          onClick={() => remember({ zoom: stepZoom(geometry.zoom, 1) })}
        >
          <Icon name="i-expand" size={12} />
        </button>
      </div>
      <div
        className="pet-stage-resize"
        role="separator"
        aria-orientation="horizontal"
        title={t("agentPanel.petStageResize")}
        onMouseDown={startResize}
        onDoubleClick={() => remember(petStageDefault(accessory.height))}
      />
    </div>
  );
}
