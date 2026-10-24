import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MediaRef } from "@tomradex/agent";
import type {} from "@tomradex/files";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { invalidateFiles } from "~/lib/files";
import { readableError } from "~/lib/toast";
import { Dialog, DialogHead, DialogBody } from "~/components/ui/dialog";
import { keys } from "~/lib/queries";

export function AgentMedia({ projectId, threadId, media, caption }: { projectId: string; threadId: string; media: MediaRef; caption?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [url, setUrl] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const [fit, setFit] = useState(false);
  const content = useQuery({
    queryKey: keys.agent.media(projectId, threadId, media.id),
    queryFn: () => invoke("agent.media.read", projectId, threadId, media.id),
    staleTime: Infinity, retry: false
  });
  useEffect(() => {
    if (!content.data) return;
    const bytes = Uint8Array.from(atob(content.data.base64), char => char.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([bytes], { type: content.data.mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [content.data]);
  const save = useMutation({
    mutationFn: async () => {
      if (!content.data) throw new Error("Media is unavailable");
      // The unique directory prevents overwriting another conversation's export.
      const name = media.name.replace(/^[.]+/, "").replace(/[\\/]/g, "-") || "artifact";
      const saved = await invoke("files.write", projectId, `Assistant/${media.id}/${name}`, content.data.base64, { encoding: "base64" });
      if (media.source) {
        const source = await invoke("agent.media.read", projectId, threadId, media.source.id);
        await invoke("files.write", projectId, `Assistant/${media.id}/diagram.json`, source.base64, { encoding: "base64" });
      }
      return saved;
    },
    onSuccess: () => invalidateFiles(qc, projectId)
  });
  const html = content.data?.mime === "text/html"
    ? new TextDecoder().decode(Uint8Array.from(atob(content.data.base64), char => char.charCodeAt(0)))
    : undefined;
  // A separate sandbox origin permits viewer controls without access to Tomrade or network.
  const isolatedHtml = html === undefined ? undefined : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none';">${html}`;
  const label = caption ?? media.name;
  const isImage = media.mime.startsWith("image/");
  const isPdf = media.mime === "application/pdf";
  const open = () => { setFit(false); setExpanded(true); };
  return <figure style={{ margin: "8px 0", minWidth: 0 }}>
    {content.isError && <p role="alert">{readableError(content.error)}</p>}
    {url && (isImage ? <button type="button" className="media-thumb" title={t("agentPanel.viewOriginal")} onClick={open}><img src={url} alt={label} /></button>
      // the frame only shows the first page; the button over it opens the whole document
      : isPdf ? <button type="button" className="media-thumb is-doc" title={t("agentPanel.viewOriginal")} onClick={open}><iframe title={label} src={`${url}#toolbar=0&navpanes=0&view=FitH`} tabIndex={-1} /></button>
      : isolatedHtml !== undefined ? <iframe title={label} srcDoc={isolatedHtml} sandbox="allow-scripts allow-downloads" style={{ width: "100%", height: 360, border: "1px solid var(--border)", borderRadius: 8 }} />
      : media.mime.startsWith("audio/") ? <audio controls src={url} style={{ width: "100%" }} />
      : media.mime.startsWith("video/") ? <video controls src={url} style={{ maxWidth: "100%" }} />
      : <p>{media.name}</p>)}
    <figcaption style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>{label}</span>
      {url && <a href={url} download={media.name}>{t("agentPanel.downloadMedia")}</a>}
      {url && <button type="button" className="btn btn-ghost" onClick={open}>{t("agentPanel.expandMedia")}</button>}
      <button type="button" className="btn btn-ghost" disabled={!content.data || save.isPending || save.isSuccess} onClick={() => save.mutate()}>
        {t(save.isSuccess ? "agentPanel.mediaSaved" : "agentPanel.saveMedia")}
      </button>
    </figcaption>
    {save.isError && <p role="alert">{readableError(save.error)}</p>}
    <Dialog open={expanded} onOpenChange={setExpanded} label={label} className={isImage || isPdf ? "sheet-image" : "sheet-settings"}>
      <DialogHead title={label} />
      {isImage ? <div className="media-stage">
        {/* original size first, scrolled when it is bigger than the window; a click fits it */}
        <img src={url} alt={label} className={fit ? "is-fit" : undefined} title={t(fit ? "agentPanel.actualSize" : "agentPanel.fitToWindow")} onClick={() => setFit(!fit)} />
      </div> : isPdf ? <iframe title={label} src={url} className="media-doc-full" />
      : <DialogBody>
        {isolatedHtml !== undefined ? <iframe title={label} srcDoc={isolatedHtml} sandbox="allow-scripts allow-downloads" style={{ width: "100%", height: "70vh", border: 0 }} />
          : media.mime.startsWith("video/") ? <video controls src={url} style={{ width: "100%", maxHeight: "70vh" }} />
          : media.mime.startsWith("audio/") ? <audio controls src={url} /> : <a href={url} download={media.name}>{t("agentPanel.downloadMedia")}</a>}
      </DialogBody>}
    </Dialog>
  </figure>;
}
