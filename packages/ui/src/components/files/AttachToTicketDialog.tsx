import { useState } from "react";
import { StatusMark } from "~/components/ui/atoms";
import { Dialog, DialogBody, DialogHead } from "~/components/ui/dialog";
import { useWorkspace } from "~/components/workspace/context";
import { nameOf, useAttachFile } from "~/lib/files";
import { useI18n } from "~/lib/i18n";
import { useToast } from "~/lib/toast";

/** From a file to a ticket: pick the ticket and the role, and the latest version is pinned. */
export function AttachToTicketDialog({ projectId, path, open, onOpenChange }: { projectId: string; path: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useI18n();
  const { owned } = useWorkspace();
  const attach = useAttachFile(projectId);
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [role, setRole] = useState<"input" | "output">("output");
  const needle = filter.trim().toLowerCase();
  const tickets = owned.filter((i) => i.status !== "done" && i.status !== "cancelled" && (!needle || `${i.key} ${i.title}`.toLowerCase().includes(needle))).slice(0, 40);
  const name = nameOf(path);
  const title = t("files.attachTitle", { name });
  return (
    <Dialog open={open} onOpenChange={onOpenChange} label={title}>
      <DialogHead title={title} />
      <DialogBody className="stack-3">
        <div className="seg quiet" role="radiogroup" aria-label={title}>
          <button type="button" aria-pressed={role === "output"} onClick={() => setRole("output")}>
            {t("files.attachAsOutput")}
          </button>
          <button type="button" aria-pressed={role === "input"} onClick={() => setRole("input")}>
            {t("files.attachAsMaterial")}
          </button>
        </div>
        <input className="input" autoFocus placeholder={t("files.attachFilter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        <div className="stack-1" style={{ maxHeight: 320, overflowY: "auto" }}>
          {tickets.map((item) => (
            <button
              key={item.id}
              type="button"
              className="menu-row"
              data-item={item.id}
              disabled={attach.isPending}
              onClick={() =>
                attach.mutate(
                  { itemId: item.id, path, role },
                  {
                    onSuccess: () => {
                      onOpenChange(false);
                      toast({ body: t("files.attachedToast", { name, key: item.key }) });
                    },
                    onError: (error) => toast({ body: error.message })
                  }
                )
              }
            >
              <span className="m-mark">
                <StatusMark status={item.status} />
              </span>
              <span className="m-stack">
                <span className="m-name">{item.title}</span>
                <span className="m-sub num">{item.key}</span>
              </span>
            </button>
          ))}
          {!tickets.length && <p className="meta-txt dense">{t("files.attachNoTickets")}</p>}
        </div>
      </DialogBody>
    </Dialog>
  );
}
