import { splitImText, type ImContent, type ImElement, type ResolvedImCapabilities } from "@tomradex/plugin-sdk";
import type { ImSpeak } from "./words.js";

/** Folds a part the platform cannot show into Markdown, so degrading never drops information. */
function fold(el: ImElement, w: ImSpeak): string {
  switch (el.type) {
    case "section": return [el.title && `**${el.title}**`, el.text, ...(el.fields ?? []).map(f => `${f.label}: ${f.value}`)].filter(Boolean).join("\n");
    case "links": return el.links.map(l => `[${l.label}](${l.url})`).join("\n");
    case "select": return el.multiple
      ? w("foldMultiSelect", { options: el.options.map(o => o.label).join(w("listSep")), token: el.token })
      : el.options.map(o => `${o.label}：/answer ${el.token} ${o.value}`).join("\n");
    case "input": return w("foldInput", { token: el.token });
  }
}

const supported = (el: ImElement, caps: ResolvedImCapabilities) => {
  switch (el.type) {
    case "section": case "links": return caps.cards;
    case "select": return el.multiple ? caps.multiSelect : caps.select;
    case "input": return caps.textInput;
  }
};

/**
 * Turns the common layer's content (Markdown text, every element) into the
 * messages one adapter can send: unsupported parts become text, the text is
 * written in the adapter's dialect and split to its limit. Controls and files
 * ride on the last message.
 */
export function prepare(content: ImContent, caps: ResolvedImCapabilities, w: ImSpeak): ImContent[] {
  const lines = [content.text];
  const elements: ImElement[] = [];
  for (const el of content.elements ?? []) {
    if (supported(el, caps)) elements.push(el);
    else lines.push(fold(el, w));
  }
  let actions = content.actions;
  if (actions?.length && !caps.buttons) {
    lines.push(actions.map(a => `${a.label}：/answer ${a.token}`).join("\n"));
    actions = undefined;
  }
  let files = content.files;
  if (files?.length && (!caps.outboundFiles || files.some(f => f.size > caps.maxFileBytes))) {
    lines.push(w("attachmentsInTomrade"));
    files = undefined;
  }
  const chunks = splitImText(lines.filter(Boolean).join("\n"), caps.maxTextLength, caps.markdown);
  const last: ImContent = { text: chunks.at(-1) ?? "" };
  if (actions) last.actions = actions;
  if (elements.length) last.elements = elements;
  if (files) last.files = files;
  return [...chunks.slice(0, -1).map(text => ({ text })), last];
}
