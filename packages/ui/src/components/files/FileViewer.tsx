import { useMemo, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { FileContent } from "@tomrade/files";
import { Spacer } from "~/components/ui/atoms";
import { formatSize } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { openExternal } from "~/lib/shell";

/** Its network is images and styles only; scripts run inside the sandboxed, origin-isolated frame, same policy as AgentMedia. */
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:">`;

const framed = (html: string): string => (/<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${CSP}`) : `${CSP}${html}`);

function Markdown({ text }: { text: string }) {
  // Inline HTML in the markdown goes through the same sanitizer as the rendered tree.
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["style", "form", "input", "button"] }), [text]);
  return (
    <article
      className="md-view body-prose"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        if (!anchor) return;
        e.preventDefault();
        if (/^https?:\/\//i.test(anchor.href)) openExternal(anchor.href);
      }}
    />
  );
}

/**
 * Reads a file the way its kind asks: markdown rendered, HTML in a sandbox,
 * SVG and images as pictures, everything else as text — with a switch to the
 * source where rendering hides it. No editing here; that is a later plugin.
 */
export function FileViewer({ content }: { content: FileContent }) {
  const { t } = useI18n();
  const [source, setSource] = useState(false);
  const renderable = content.encoding === "utf8" && (content.mime === "text/markdown" || content.mime === "text/html" || content.mime === "image/svg+xml");
  const body = (() => {
    if (content.encoding === "utf8") {
      if (renderable && !source) {
        if (content.mime === "text/markdown") return <Markdown text={content.body} />;
        if (content.mime === "text/html") return <iframe className="html-view" sandbox="allow-scripts" srcDoc={framed(content.body)} title={content.name} />;
        return <img className="image-view" src={`data:image/svg+xml;utf8,${encodeURIComponent(content.body)}`} alt={content.name} />;
      }
      return <pre className="text-view">{content.body}</pre>;
    }
    if (content.mime.startsWith("image/") && content.body) return <img className="image-view" src={`data:${content.mime};base64,${content.body}`} alt={content.name} />;
    return (
      <div className="files-empty">
        <p className="meta-txt">{t("files.previewUnavailable")}</p>
        <p className="meta-txt num">
          {content.mime} · {formatSize(content.size)}
        </p>
      </div>
    );
  })();
  return (
    <div className="file-view" data-mime={content.mime} data-testid="file-view">
      {(renderable || content.truncated) && (
        <div className="row file-view-bar">
          {content.truncated && <span className="meta-txt">{t("files.truncated")}</span>}
          <Spacer />
          {renderable && (
            <div className="seg quiet" role="group">
              <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
                {t("files.showRendered")}
              </button>
              <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
                {t("files.showSource")}
              </button>
            </div>
          )}
        </div>
      )}
      {body}
    </div>
  );
}
