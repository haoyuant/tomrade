import { useEffect, useState } from "react";
import { useI18n } from "~/lib/i18n";

export function AgentAttachment({ file, remove, disabled }: { file: File; remove(): void; disabled: boolean }) {
  const { t } = useI18n();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const next = URL.createObjectURL(file); setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return <div className="tag" style={{ display: "flex", gap: 6, maxWidth: "100%" }}>
    {file.type.startsWith("image/") && <img src={url} alt="" style={{ width: 40, height: 40, objectFit: "contain" }} />}
    <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{file.name}</span>
    <button type="button" className="btn btn-icon" onClick={remove} disabled={disabled} aria-label={t("agentPanel.removeAttachment", { name: file.name })}>×</button>
  </div>;
}

export function readAttachment(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
    reader.readAsDataURL(file);
  });
}
