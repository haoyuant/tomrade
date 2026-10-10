import { useMemo, useState } from "react";
import type { FileContent } from "@tomradex/files";
import { Spacer } from "~/components/ui/atoms";
import { formatSize } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { renderMarkdown, type LinkResolver } from "~/lib/markdown";
import { openExternal } from "~/lib/shell";

/** How a note's links behave: which resolve, where a click goes, what a tag does. */
export interface NoteLinking {
  resolve: LinkResolver;
  open: (target: string, kind: "wiki" | "markdown") => void;
  tag: (tag: string) => void;
}

/** Its network is images and styles only; scripts run inside the sandboxed, origin-isolated frame, same policy as AgentMedia. */
const CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; img-src data: https:; style-src 'unsafe-inline' https:; font-src data: https:">`;

const framed = (html: string): string => (/<head[\s>]/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${CSP}`) : `${CSP}${html}`);

function Markdown({ text, linking }: { text: string; linking?: NoteLinking }) {
  // Inline HTML in the markdown goes through the same sanitizer as the rendered tree.
  const html = useMemo(() => renderMarkdown(text, linking?.resolve), [text, linking?.resolve]);
  return (
    <article
      className="md-view body-prose"
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={(e) => {
        const anchor = (e.target as HTMLElement).closest("a");
        if (!anchor) return;
        e.preventDefault();
        if (anchor.dataset.tag) return linking?.tag(anchor.dataset.tag);
        if (anchor.classList.contains("wikilink")) return linking?.open(anchor.dataset.target ?? "", "wiki");
        const href = anchor.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) openExternal(href);
        else if (href && !href.startsWith("#") && !/^[a-z][a-z0-9+.-]*:/i.test(href)) {
          let target = href.split("#")[0]!;
          try {
            target = decodeURI(target);
          } catch {
            // as written
          }
          linking?.open(target, "markdown");
        }
      }}
    />
  );
}

/**
 * Reads a file the way its kind asks: markdown rendered with its links live,
 * HTML in a sandbox, SVG and images as pictures, everything else as text —
 * with a switch to the source where rendering hides it, unless the screen
 * around it offers editing instead (`switch={false}`).
 */
export function FileViewer({ content, linking, switch: showSwitch = true }: { content: FileContent; linking?: NoteLinking; switch?: boolean }) {
  const { t } = useI18n();
  const [source, setSource] = useState(false);
  const renderable = content.encoding === "utf8" && (content.mime === "text/markdown" || content.mime === "text/html" || content.mime === "image/svg+xml");
  const body = (() => {
    if (content.encoding === "utf8") {
      if (renderable && (!source || !showSwitch)) {
        if (content.mime === "text/markdown") return <Markdown text={content.body} linking={linking} />;
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
      {((renderable && showSwitch) || content.truncated) && (
        <div className="row file-view-bar">
          {content.truncated && <span className="meta-txt">{t("files.truncated")}</span>}
          <Spacer />
          {renderable && showSwitch && (
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
