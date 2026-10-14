import { expect, it } from "vitest";
import {
  PET_MAX_ZOOM,
  PET_MIN_ZOOM,
  PET_POSITION_CENTER,
  PET_STAGE_BORDER,
  PET_STAGE_HANDLE,
  PET_STAGE_MAX_HEIGHT,
  PET_STAGE_MIN_HEIGHT,
  PET_ZOOM_STEP,
  clampStageHeight,
  clampZoom,
  heightFromDrag,
  movePosition,
  parsePetPosition,
  parsePetStage,
  petDrawScale,
  petHeightOf,
  petOffset,
  petStageDefault,
  serializePetPosition,
  serializePetStage,
  stepZoom
} from "../src/lib/petStage";

/** The built-in pet's own drawing size, as the accessory declares it. */
const PET = { width: 151, height: 120 };
/** What the zone has to be, exactly, for the pet's whole height to be drawn at `zoom`. */
const zoneFor = (zoom: number) => PET.height * zoom + PET_STAGE_HANDLE + PET_STAGE_BORDER;
/** How tall the pet is drawn, which the canvas' CSS height rounds to whole pixels. */
const drawn = (height: number, zoom: number) => Math.round(PET.height * petDrawScale({ height, zoom }, PET.height));

it("bounds the zone height the person drags, from either direction", () => {
  expect(clampStageHeight(10)).toBe(PET_STAGE_MIN_HEIGHT);
  expect(clampStageHeight(10_000)).toBe(PET_STAGE_MAX_HEIGHT);
  expect(clampStageHeight(petStageDefault(PET.height).height)).toBe(127);
  expect(heightFromDrag(127, 100)).toBe(227);
  expect(heightFromDrag(127, -1_000)).toBe(PET_STAGE_MIN_HEIGHT);
});

it("resets to the pet at its natural size, entirely visible, at 1×", () => {
  const geometry = petStageDefault(PET.height);
  expect(geometry).toEqual({ height: zoneFor(1), zoom: PET_MIN_ZOOM });
  expect(petDrawScale(geometry, PET.height)).toBe(1);
  expect(drawn(geometry.height, geometry.zoom)).toBeLessThanOrEqual(petHeightOf(geometry.height));
});

it("zooms in quarter steps, never past 2×", () => {
  expect(PET_ZOOM_STEP).toBe(0.25);
  expect(stepZoom(1, 1)).toBe(1.25);
  expect(stepZoom(1.25, -1)).toBe(1);
  expect(stepZoom(1, -1)).toBe(PET_MIN_ZOOM);
  expect(stepZoom(PET_MAX_ZOOM, 1)).toBe(PET_MAX_ZOOM);
  expect(clampZoom(99)).toBe(PET_MAX_ZOOM);
  expect([0, 1, 2, 3].reduce<number>((zoom) => stepZoom(zoom, 1), 1)).toBe(PET_MAX_ZOOM);
});

it("draws the pet at 2× once the zone is tall enough for it", () => {
  const tall = { height: zoneFor(PET_MAX_ZOOM), zoom: PET_MAX_ZOOM };
  expect(petDrawScale(tall, PET.height)).toBe(PET_MAX_ZOOM);
  expect(drawn(tall.height, tall.zoom)).toBe(PET.height * PET_MAX_ZOOM);
  expect(drawn(tall.height, tall.zoom)).toBeLessThanOrEqual(petHeightOf(tall.height));
});

it("limits the zoom to the room a short zone has, instead of letting the pet overflow", () => {
  const short = { height: zoneFor(1.5), zoom: PET_MAX_ZOOM };
  expect(petDrawScale(short, PET.height)).toBe(1.5);
  expect(drawn(short.height, short.zoom)).toBeLessThanOrEqual(petHeightOf(short.height));

  // Between the two, the zoom given up is only the part that does not fit.
  const middle = { height: zoneFor(1.75), zoom: PET_MAX_ZOOM };
  expect(drawn(middle.height, middle.zoom)).toBe(1.75 * PET.height);
});

it("never shrinks the pet below its own size, however short the zone is", () => {
  expect(petDrawScale({ height: PET_STAGE_MIN_HEIGHT, zoom: 1 }, PET.height)).toBe(1);
  expect(petDrawScale({ height: PET_STAGE_MIN_HEIGHT, zoom: PET_MAX_ZOOM }, PET.height)).toBe(1);
});

it("keeps what was stored, and falls back on anything else", () => {
  const stored = { height: 200, zoom: 1.75 };
  expect(parsePetStage(serializePetStage(stored), PET.height)).toEqual(stored);
  expect(parsePetStage(null, PET.height)).toEqual(petStageDefault(PET.height));
  expect(parsePetStage("{ not json", PET.height)).toEqual(petStageDefault(PET.height));
  expect(parsePetStage(JSON.stringify({ height: 9_999, zoom: 9 }), PET.height)).toEqual({ height: PET_STAGE_MAX_HEIGHT, zoom: PET_MAX_ZOOM });
  expect(parsePetStage(JSON.stringify({ zoom: 0.25 }), PET.height)).toEqual({ height: petStageDefault(PET.height).height, zoom: PET_MIN_ZOOM });
});

it("moves the pet by exactly the distance the pointer travelled", () => {
  const free = { width: 200, height: 50 };
  expect(movePosition({ x: 0.5, y: 1 }, 20, -25, free)).toEqual({ x: 0.6, y: 0.5 });
});

it("never lets a drag take the pet out of its zone", () => {
  const free = { width: 200, height: 50 };
  expect(movePosition(PET_POSITION_CENTER, 10_000, 10_000, free)).toEqual({ x: 1, y: 1 });
  expect(movePosition(PET_POSITION_CENTER, -10_000, -10_000, free)).toEqual({ x: 0, y: 0 });
});

it("keeps an axis where it is when the pet fills the zone along it", () => {
  expect(movePosition({ x: 0.3, y: 0.8 }, 40, 40, { width: 0, height: -12 })).toEqual({ x: 0.3, y: 0.8 });
});

it("resolves a remembered spot against the zone it has now, so a resize cannot strand the pet", () => {
  const position = { x: 1, y: 0 };
  expect(petOffset(position, 100, 80)).toEqual({ left: "calc((100% - 100px) * 1)", top: "calc((100% - 80px) * 0)" });
  expect(petOffset(PET_POSITION_CENTER, 100, 80)).toEqual({ left: "calc((100% - 100px) * 0.5)", top: "calc((100% - 80px) * 1)" });
});

it("keeps a stored position, and falls back on the centre for anything else", () => {
  expect(parsePetPosition(serializePetPosition({ x: 0.25, y: 0.5 }))).toEqual({ x: 0.25, y: 0.5 });
  expect(parsePetPosition(null)).toEqual(PET_POSITION_CENTER);
  expect(parsePetPosition("{ not json")).toEqual(PET_POSITION_CENTER);
  expect(parsePetPosition(JSON.stringify({ x: 7, y: -3 }))).toEqual({ x: 1, y: 0 });
  expect(parsePetPosition(JSON.stringify({ x: 0.1 }))).toEqual({ x: 0.1, y: PET_POSITION_CENTER.y });
});
