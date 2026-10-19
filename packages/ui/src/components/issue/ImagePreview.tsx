import { useEffect } from "react";
import { Icon } from "~/components/icons";
import { Dialog, DialogHead } from "~/components/ui/dialog";
import { useI18n } from "~/lib/i18n";

export interface PreviewImage {
  fileId: string;
  name: string;
  src: string;
}

/**
 * A closer look at a body's images without leaving the ticket. The sheet
 * fills the window and the image fits inside it; Open in Files is the one way
 * on to the file.
 */
export function ImagePreview({
  images,
  at,
  onStep,
  onClose,
  onOpenInFiles
}: {
  images: PreviewImage[];
  at: number | null;
  onStep: (at: number) => void;
  onClose: () => void;
  onOpenInFiles: (image: PreviewImage) => void;
}) {
  const { t } = useI18n();
  const image = at === null ? undefined : images[at];
  const many = images.length > 1;
  const step = (by: number) => at !== null && onStep((at + by + images.length) % images.length);

  useEffect(() => {
    if (!image || !many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      // the arrows are the preview's while it is open, not the board's behind it
      e.preventDefault();
      e.stopPropagation();
      step(e.key === "ArrowRight" ? 1 : -1);
    };
    // captured: the host stops keys bubbling out of the preview so they never reach the ticket behind it
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  return (
    <Dialog open={!!image} onOpenChange={(open) => !open && onClose()} label={image?.name ?? ""} className="sheet-image">
      {image && (
        <>
          <DialogHead title={image.name} aside={many && <span className="meta-txt num">{t("fields.imagePreviewCount", { n: at! + 1, total: images.length })}</span>}>
            <button type="button" className="btn btn-ghost" onClick={() => onOpenInFiles(image)}>
              <Icon name="i-folder" size={13} />
              {t("fields.imagePreviewOpenInFiles")}
            </button>
          </DialogHead>
          {/* the stage around the image reads as backdrop, so a click there closes too */}
          <div className="image-preview-stage" onClick={(e) => e.target === e.currentTarget && onClose()}>
            <img src={image.src} alt={image.name} />
            {many && (
              <>
                <button type="button" className="btn btn-icon image-preview-step is-prev" aria-label={t("fields.imagePreviewPrev")} title={t("fields.imagePreviewPrev")} onClick={() => step(-1)}>
                  <Icon name="i-back" size={16} />
                </button>
                <button type="button" className="btn btn-icon image-preview-step is-next" aria-label={t("fields.imagePreviewNext")} title={t("fields.imagePreviewNext")} onClick={() => step(1)}>
                  <Icon name="i-chev" size={16} />
                </button>
              </>
            )}
          </div>
        </>
      )}
    </Dialog>
  );
}
