import type { TurnIO, TurnInput } from "./turn.js";

export function attachedMedia(input: TurnInput, io: TurnIO) {
  const refs = input.input.kind === "text" ? input.input.attachments ?? [] : [];
  if (refs.length && !io.media) throw new Error("Media input is unavailable in this runtime");
  return refs.map(ref => io.media!.read(ref.id));
}

export function claudeMediaInput(input: TurnInput, io: TurnIO, text: string) {
  return [
    { type: "text" as const, text },
    ...attachedMedia(input, io).map(media => ({
      type: media.mime === "application/pdf" ? "document" as const : "image" as const,
      source: { type: "base64" as const, media_type: media.mime, data: media.base64 }
    }))
  ];
}

export function codexMediaInput(input: TurnInput, io: TurnIO, text: string) {
  return [
    { type: "text", text, text_elements: [] },
    ...attachedMedia(input, io).map(media => ({ type: media.mime.startsWith("audio/") ? "audio" : "image", url: `data:${media.mime};base64,${media.base64}` }))
  ];
}

/** Codex app-server imageGeneration items contain final base64 image bytes. */
export function publishNativeImage(item: { type?: string; result?: string; status?: string }, io: TurnIO): void {
  if ((item.type === "imageGeneration" || item.type === "image_generation") && item.result && item.status !== "failed") {
    const data = item.result.replace(/^data:image\/png;base64,/, "");
    if (!io.media) throw new Error("Media output is unavailable in this runtime");
    io.media.publish({ name: "generated.png", mime: "image/png", base64: data });
  }
}
