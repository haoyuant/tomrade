export { OpenAICompatibleProvider, FakeProvider, LlmError } from "./provider.js";
export type { LLMProvider, ProviderConfig } from "./provider.js";
export { extractTickets } from "./extract.js";
export type { ExtractCandidate } from "./extract.js";
export { checkDuplicate } from "./dedup.js";
export type { DedupInput, DedupResult } from "./dedup.js";
export { gapAnalysis } from "./gap.js";
export type { GapCandidate } from "./gap.js";