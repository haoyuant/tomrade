import type { Words } from "./selection";

let cut: ((text: string) => string[]) | null = null;
let loading: Promise<unknown> | null = null;

/** jieba's dictionary, loaded on the first double-click in Chinese. */
export const chineseWords: Words = {
  cut: (text) => cut?.(text) ?? null,
  load: () =>
    (loading ??= import("jieba-wasm").then(async (jieba) => {
      await jieba.default();
      cut = (text) => jieba.cut(text, true);
    })),
};
