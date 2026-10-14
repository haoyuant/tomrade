import type { AssistantAccessory } from "@tomradex/contributions";
import { useCallback, useRef, useState } from "react";
import { Icon } from "~/components/icons";
import { ContextMenu, ContextMenuActionItem } from "~/components/ui/menu";
import { useI18n } from "~/lib/i18n";
import { useAccessoryState } from "~/lib/pet";
import {
  PET_MAX_ZOOM,
  PET_MIN_ZOOM,
  PET_NUDGE,
  PET_POSITION_CENTER,
  PET_POSITION_KEY,
  PET_STAGE_KEY,
  heightFromDrag,
  movePosition,
  parsePetPosition,
  parsePetStage,
  petDrawScale,
  petOffset,
  petStageDefault,
  serializePetPosition,
  serializePetStage,
  stepZoom,
  type PetPosition,
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

  const [position, setPosition] = useState<PetPosition>(() => parsePetPosition(localStorage.getItem(PET_POSITION_KEY)));
  const place = useRef(position);
  const room = useRef<HTMLDivElement>(null);
  // The room the pet can still move in, at the size it is drawn right now.
  const petSize = useRef({ width: 0, height: 0 });

  const placePet = useCallback((next: PetPosition) => {
    place.current = next;
    setPosition(next);
    localStorage.setItem(PET_POSITION_KEY, serializePetPosition(next));
  }, []);

  const freeRoom = () => ({
    width: (room.current?.clientWidth ?? 0) - petSize.current.width,
    height: (room.current?.clientHeight ?? 0) - petSize.current.height
  });

  const startMove = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const [startX, startY, from] = [event.clientX, event.clientY, place.current];
      document.body.style.userSelect = "none";
      document.body.style.cursor = "grabbing";
      const onMove = (e: MouseEvent) => placePet(movePosition(from, e.clientX - startX, e.clientY - startY, freeRoom()));
      const onUp = () => {
        document.body.style.userSelect = "";
        document.body.style.cursor = "";
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [placePet]
  );

  const onPetKey = (event: React.KeyboardEvent) => {
    const step = { ArrowLeft: [-PET_NUDGE, 0], ArrowRight: [PET_NUDGE, 0], ArrowUp: [0, -PET_NUDGE], ArrowDown: [0, PET_NUDGE] }[event.key];
    if (!step) return;
    event.preventDefault();
    placePet(movePosition(place.current, step[0], step[1], freeRoom()));
  };

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
  const [petWidth, petHeight] = [Math.round(accessory.width * scale), Math.round(accessory.height * scale)];
  petSize.current = { width: petWidth, height: petHeight };
  return (
    <div className="pet-stage" data-pet-state={mood} style={{ height: geometry.height }}>
      <div className="pet-stage-pet" ref={room}>
        <ContextMenu
          label={accessory.title}
          trigger={
            <div
              className="pet-stage-actor"
              role="group"
              tabIndex={0}
              aria-label={t("agentPanel.petMove")}
              title={t("agentPanel.petMove")}
              style={{ ...petOffset(position, petWidth, petHeight), width: petWidth, height: petHeight }}
              onMouseDown={startMove}
              onKeyDown={onPetKey}
            >
              <PetCanvas className="pet-canvas" animation={animation} width={petWidth} height={petHeight} label={`${accessory.title}: ${mood}`} />
            </div>
          }
        >
          <ContextMenuActionItem icon={<Icon name="i-undo" size={13} />} name={t("agentPanel.petRecenter")} onSelect={() => placePet(PET_POSITION_CENTER)} />
        </ContextMenu>
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
