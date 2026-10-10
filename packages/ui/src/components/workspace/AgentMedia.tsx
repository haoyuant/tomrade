import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MediaRef } from "@tomradex/agent";
import type {} from "@tomradex/files";
import { invoke } from "~/lib/api";
import { useI18n } from "~/lib/i18n";
import { invalidateFiles } from "~/lib/files";
import { Dialog, DialogHead, DialogBody } from "~/components/ui/dialog";

export function AgentMedia({ projectId, threadId, media, caption }: { projectId: string; threadId: string; media: MediaRef; caption?: string }) {
  const { t } = useI18n();
  const qc = useQueryClient();
  const [url, setUrl] = useState<string>();
  const [expanded, setExpanded] = useState(false);
  const content = useQuery({
    queryKey: ["agent-media", projectId, threadId, media.id],
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
  return <figure style={{ margin: "8px 0", minWidth: 0 }}>
    {content.isError && <p role="alert">{content.error.message}</p>}
    {url && (media.mime.startsWith("image/") ? <img src={url} alt={caption ?? media.name} style={{ maxWidth: "100%", borderRadius: 8 }} />
      : isolatedHtml !== undefined ? <iframe title={caption ?? media.name} srcDoc={isolatedHtml} sandbox="allow-scripts allow-downloads" style={{ width: "100%", height: 360, border: "1px solid var(--border)", borderRadius: 8 }} />
      : media.mime.startsWith("audio/") ? <audio controls src={url} style={{ width: "100%" }} />
      : media.mime.startsWith("video/") ? <video controls src={url} style={{ maxWidth: "100%" }} />
      : <p>{media.name}</p>)}
    <figcaption style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
      <span>{caption ?? media.name}</span>
      {url && <a href={url} download={media.name}>{t("agentPanel.downloadMedia")}</a>}
      {url && <button type="button" className="btn btn-ghost" onClick={() => setExpanded(true)}>{t("agentPanel.expandMedia")}</button>}
      <button type="button" className="btn btn-ghost" disabled={!content.data || save.isPending || save.isSuccess} onClick={() => save.mutate()}>
        {t(save.isSuccess ? "agentPanel.mediaSaved" : "agentPanel.saveMedia")}
      </button>
    </figcaption>
    {save.isError && <p role="alert">{save.error.message}</p>}
    <Dialog open={expanded} onOpenChange={setExpanded} label={caption ?? media.name} className="sheet-settings">
      <DialogHead title={caption ?? media.name} />
      <DialogBody>
        {isolatedHtml !== undefined ? <iframe title={caption ?? media.name} srcDoc={isolatedHtml} sandbox="allow-scripts allow-downloads" style={{ width: "100%", height: "70vh", border: 0 }} />
          : media.mime.startsWith("image/") ? <img src={url} alt={caption ?? media.name} style={{ width: "100%", maxHeight: "70vh", objectFit: "contain" }} />
          : media.mime.startsWith("video/") ? <video controls src={url} style={{ width: "100%", maxHeight: "70vh" }} />
          : media.mime.startsWith("audio/") ? <audio controls src={url} /> : <a href={url} download={media.name}>{t("agentPanel.downloadMedia")}</a>}
      </DialogBody>
    </Dialog>
  </figure>;
}
