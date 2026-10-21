import { OpenAiCompatible, type ChatModel, type ModelProviderSpec as CoreModelProvider } from "@tomradex/llm";
import { wordsFor, type CompatibleModelOptions, type Localized, type ModelChat, type ModelChatEvent, type ModelProviderSpec } from "@tomradex/plugin-sdk";
import type { Host } from "../host.js";
import { within } from "../scope.js";
import { copy } from "./shared.js";
import { bestEffort, errorMessage } from "@tomradex/contracts";

/** A plugin's headers as fetch takes them; anything but an object of names and values is refused. */
export const strings = (headers: unknown): Record<string, string> => {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) throw new Error("headers must be an object of names and values");
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)]));
};

/** A stream the plugin yields, each step pulled inside its scope. */
async function* pulled<T>(host: Host, open: () => AsyncIterable<T>): AsyncGenerator<T> {
  const it = await within(host.ns, () => open()[Symbol.asyncIterator]());
  let done = false;
  try {
    for (;;) {
      const step = await within(host.ns, () => it.next());
      if (step.done) {
        done = true;
        return;
      }
      yield step.value;
    }
  } finally {
    // A turn cut short (aborted, or the caller stopped reading) lets the plugin clean up.
    if (!done) await bestEffort(within(host.ns, () => it.return?.()), host.logger, "closing a model stream cut short");
  }
}

/** A plugin's model provider as core reads one: every call back runs in its scope, and what it leaves out takes the defaults. */
export const modelProvider = (host: Host, spec: ModelProviderSpec): CoreModelProvider => {
  const label = `model provider ${spec.id}`;
  const both = (w: Localized | undefined) => (w === undefined ? { en: "", zh: "" } : typeof w === "string" ? { en: w, zh: w } : { en: wordsFor("en", w), zh: wordsFor("zh", w) });
  const signIn = spec.signIn ? host.back(spec.signIn.run.bind(spec.signIn), `${label} sign-in`) : null;
  const chatOf = (model: ModelChat): ChatModel => ({
    get capabilities() {
      return host.now(() => copy(model.capabilities), `${label} capabilities`, () => ({ tools: false, streaming: true, json: false }));
    },
    // its own copy of the conversation, so nothing it changes reaches the transcript
    chat: (request, signal) => pulled<ModelChatEvent>(host, () => model.chat(copy(request), signal))
  });
  return {
    id: spec.id,
    title: both(spec.title),
    keyRequired: spec.keyRequired ?? true,
    baseURL: { default: spec.baseURL.default, editable: spec.baseURL.editable ?? true },
    chat: spec.chat ?? true,
    presets: (spec.presets ?? []).map((p) => ({
      id: p.id,
      title: p.title,
      // none: the provider's own default, as it is for a profile without an address
      baseURL: p.baseURL ?? "",
      model: p.model ?? "",
      prefer: p.prefer ?? [],
      ...(p.keyPage ? { keyPage: p.keyPage } : {}),
      ...(p.env ? { env: p.env } : {}),
      ...(p.keyShapes ? { keyShapes: p.keyShapes } : {}),
      ...(p.local ? { local: true } : {}),
      hint: both(p.hint)
    })),
    list: async (endpoint, timeoutMs = 15_000) => {
      try {
        // held to the time even when the plugin does not listen to the signal
        const listed = await host.back(spec.list.bind(spec), `${label} list`, { ms: timeoutMs })({ ...endpoint }, AbortSignal.timeout(timeoutMs));
        return listed.ok ? { ok: true, models: listed.models, capabilities: listed.capabilities ?? {} } : listed;
      } catch (error) {
        return { ok: false, detail: errorMessage(error) };
      }
    },
    usable: (listed) => (spec.usable ? host.now(() => spec.usable!([...listed]), `${label} usable`, () => listed) : listed),
    defaultInput: spec.defaultInput ?? [],
    capabilities: (model, listed) => (spec.capabilities ? host.now(() => spec.capabilities!(model, copy(listed)), `${label} capabilities`, () => listed) : listed),
    ...(signIn ? { signIn: { title: both(spec.signIn!.title), run: (helpers: { open(url: string): void; signal: AbortSignal }) => signIn(helpers) } } : {}),
    build: (profile) =>
      chatOf(
        host.now(() => spec.build(copy(profile)), `${label} build`, (message) => {
          throw new Error(`${both(spec.title).en} could not start ${profile.model}: ${message}`);
        })
      )
  };
};

/** The app's own OpenAI-compatible adapter for a plugin's provider; its `body` and `headers` run in the plugin's scope. */
export const compatible = (host: Host, options: CompatibleModelOptions): ChatModel => {
  host.svc("models");
  const shape = options.body;
  const answer = options.responses;
  const label = `compatible model ${options.model} body`;
  const sign = options.headers ? host.back(options.headers.bind(options), `compatible model ${options.model} headers`, { ms: 30_000 }) : null;
  return new OpenAiCompatible({
    baseURL: String(options.baseURL),
    apiKey: String(options.apiKey ?? ""),
    model: String(options.model),
    inputModalities: options.inputModalities,
    outputModalities: options.outputModalities,
    webSearch: options.webSearch === "chat" ? "chat" : options.webSearch === "responses",
    ...(shape
      ? {
          body: (json: Record<string, unknown>, request: Parameters<ChatModel["chat"]>[0]) =>
            host.now(() => shape(json, copy(request)), label, (message) => {
              throw new Error(`${host.identity.id} could not shape the request: ${message}`);
            })
        }
      : {}),
    ...(answer
      ? {
          responses: (json: Record<string, unknown>, request: Parameters<ChatModel["chat"]>[0]) =>
            host.now(() => answer(json, copy(request)), `compatible model ${options.model} responses`, (message) => {
              throw new Error(`${host.identity.id} could not shape the request: ${message}`);
            })
        }
      : {}),
    ...(sign
      ? {
          headers: async (request: { url: string; body: string }) => {
            try {
              return strings(await sign({ ...request }));
            } catch (error) {
              throw new Error(`${host.identity.id} could not set the request headers: ${errorMessage(error)}`);
            }
          }
        }
      : {})
  });
};
