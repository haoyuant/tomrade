import type { InputModality, OutputModality } from "./model.js";

/** What a model reads and makes besides text, as Tomrade detects it; a profile stores it as is. */
export interface ModelCapabilities {
  inputModalities: InputModality[];
  outputModalities: OutputModality[];
}

/** A listing entry's modality fields: DeepSeek puts them on the entry, OpenRouter under `architecture`. */
export interface ListedModel {
  id?: string;
  input_modalities?: unknown;
  output_modalities?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown };
}

const INPUTS: InputModality[] = ["image", "pdf", "audio", "video"];
const OUTPUTS: OutputModality[] = ["image", "audio"];
// OpenRouter calls documents "file"; Tomrade sends PDFs as files.
const INPUT_NAMES: Record<string, InputModality> = { image: "image", file: "pdf", pdf: "pdf", audio: "audio", video: "video" };

const named = <T extends string>(values: unknown, names: Record<string, T>, order: T[]): T[] => {
  const found = new Set(Array.isArray(values) ? values.map((v) => names[String(v).toLowerCase()]).filter(Boolean) : []);
  return order.filter((mode) => found.has(mode));
};

/** What the entry says about itself; null when it names no modalities. */
export function listedCapabilities(entry: ListedModel): ModelCapabilities | null {
  const own = Array.isArray(entry.input_modalities) || Array.isArray(entry.output_modalities);
  const source = own ? entry : entry.architecture;
  if (!source || (!Array.isArray(source.input_modalities) && !Array.isArray(source.output_modalities))) return null;
  return {
    inputModalities: named(source.input_modalities, INPUT_NAMES, INPUTS),
    outputModalities: named(source.output_modalities, { image: "image", audio: "audio" }, OUTPUTS)
  };
}

const caps = (inputModalities: InputModality[], outputModalities: OutputModality[] = []): ModelCapabilities => ({ inputModalities, outputModalities });

// For OpenAI-style listings that carry no modality fields; anything else is left undetected.
const KNOWN: [RegExp, ModelCapabilities][] = [
  [/^(gpt-4o(-mini)?-audio|gpt-audio)/, caps(["audio"], ["audio"])],
  [/^(gpt|chatgpt|o\d).*(realtime|search|transcribe|tts)|^o[13]-mini/, caps([])],
  [/^(chatgpt-4o|gpt-4o|gpt-4\.1|gpt-4\.5|gpt-5|o[134])/, caps(["image", "pdf"])],
  [/^(models\/)?gemini-/, caps(["image", "audio"])],
  [/vision|llava|vl[-:]|-vl$/, caps(["image"])]
];

/**
 * A model's capabilities: its listing entry's own word first, then what Tomrade
 * knows of the provider. Undefined when neither says, so a stored value stays.
 */
export function detectCapabilities(provider: "openai-compatible" | "anthropic" | "openai-images", model: string, listed?: ModelCapabilities): ModelCapabilities | undefined {
  if (listed) return listed;
  if (provider === "anthropic") return caps(["image", "pdf"]);
  if (provider === "openai-images") return undefined;
  return KNOWN.find(([pattern]) => pattern.test(model))?.[1];
}

/** Whether a profile already stores these capabilities, in any order. */
export function sameCapabilities(profile: { inputModalities?: InputModality[]; outputModalities?: OutputModality[] }, detected: ModelCapabilities): boolean {
  const same = <T>(a: T[] | undefined, b: T[]) => a !== undefined && a.length === b.length && b.every((v) => a.includes(v));
  return same(profile.inputModalities, detected.inputModalities) && same(profile.outputModalities, detected.outputModalities);
}
