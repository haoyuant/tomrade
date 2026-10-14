/**
 * The embedded pet zone's geometry: how tall the person dragged it and how far
 * they zoomed the pet. Both are bounded, and the pet is never drawn larger than
 * the zone can show, so a tall zone and a 2× zoom never clip or overflow.
 */
export const PET_STAGE_KEY = "tomrade.pet.stage";
/** The drag strip along the zone's bottom edge; the pet gets the rest. */
export const PET_STAGE_HANDLE = 6;
/** The hairline the zone draws below itself; it comes out of the same height. */
export const PET_STAGE_BORDER = 1;
export const PET_STAGE_MIN_HEIGHT = 64;
export const PET_STAGE_MAX_HEIGHT = 320;
export const PET_MIN_ZOOM = 1;
export const PET_MAX_ZOOM = 2;
export const PET_ZOOM_STEP = 0.25;

export interface PetStageGeometry {
  /** The whole zone, handle included. */
  height: number;
  zoom: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const clampStageHeight = (value: number) =>
  Number.isFinite(value) ? Math.round(clamp(value, PET_STAGE_MIN_HEIGHT, PET_STAGE_MAX_HEIGHT)) : PET_STAGE_MIN_HEIGHT;

export const clampZoom = (value: number) => (Number.isFinite(value) ? clamp(Math.round(value / PET_ZOOM_STEP) * PET_ZOOM_STEP, PET_MIN_ZOOM, PET_MAX_ZOOM) : PET_MIN_ZOOM);

/** What double-click restores: the pet at its natural size, fully visible. */
export const petStageDefault = (petHeight: number): PetStageGeometry => ({ height: clampStageHeight(petHeight + PET_STAGE_HANDLE + PET_STAGE_BORDER), zoom: PET_MIN_ZOOM });

/** The room the pet itself has: the handle and the zone's own border are not its. */
export const petHeightOf = (height: number) => Math.max(0, height - PET_STAGE_HANDLE - PET_STAGE_BORDER);

/**
 * How large the pet is actually drawn. The zoom is the person's wish; a zone
 * too short to show it wins, and the pet never shrinks below its natural size —
 * an undersized zone clips it, as it always did.
 */
export function petDrawScale(geometry: PetStageGeometry, petHeight: number): number {
  if (!(petHeight > 0)) return PET_MIN_ZOOM;
  const fits = petHeightOf(geometry.height) / petHeight;
  return Math.min(clampZoom(geometry.zoom), Math.max(PET_MIN_ZOOM, fits));
}

export const stepZoom = (zoom: number, direction: 1 | -1) => clampZoom(clampZoom(zoom) + direction * PET_ZOOM_STEP);

/** A drag of the bottom handle: downward is taller, bounded, rounded to whole pixels. */
export const heightFromDrag = (startHeight: number, deltaY: number) => clampStageHeight(startHeight + deltaY);

/** Stored geometry, or the default when it is missing, stale or malformed. */
export function parsePetStage(raw: string | null, petHeight: number): PetStageGeometry {
  const fallback = petStageDefault(petHeight);
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as { height?: unknown; zoom?: unknown };
    if (typeof value !== "object" || value === null) return fallback;
    return {
      height: typeof value.height === "number" ? clampStageHeight(value.height) : fallback.height,
      zoom: typeof value.zoom === "number" ? clampZoom(value.zoom) : fallback.zoom
    };
  } catch {
    return fallback;
  }
}

export const serializePetStage = (geometry: PetStageGeometry) => JSON.stringify(geometry);
