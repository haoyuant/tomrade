import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Dialog, DialogBody, DialogFoot } from "~/components/ui/dialog";
import { useI18n } from "~/lib/i18n";

export interface ConfirmSpec {
  body: string;
  /** The button that goes ahead; "Delete" when not said. */
  yes?: string;
  /** Goes ahead with something that cannot be taken back: the button reads as danger. */
  danger?: boolean;
}

type Ask = (spec: ConfirmSpec) => Promise<boolean>;
const Ctx = createContext<Ask>(async () => false);

/** The app's one way to ask before acting: a sheet of its own, not the system's window.confirm. */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [asking, setAsking] = useState<ConfirmSpec | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const settle = (yes: boolean) => {
    answer.current?.(yes);
    answer.current = null;
    setAsking(null);
  };
  const ask = useCallback<Ask>((spec) => {
    answer.current?.(false);
    setAsking(spec);
    return new Promise<boolean>((resolve) => { answer.current = resolve; });
  }, []);
  return (
    <Ctx.Provider value={ask}>
      {children}
      <Dialog open={!!asking} onOpenChange={(open) => { if (!open) settle(false); }} label={asking?.body ?? ""} className="confirm-sheet">
        <DialogBody>
          <p data-testid="confirm-body">{asking?.body}</p>
        </DialogBody>
        <DialogFoot>
          <button type="button" className="btn btn-ghost" onClick={() => settle(false)}>
            {t("common.cancel")}
          </button>
          <button type="button" autoFocus className={asking?.danger === false ? "btn btn-primary" : "btn btn-danger"} data-testid="confirm-yes" onClick={() => settle(true)}>
            {asking?.yes ?? t("common.delete")}
          </button>
        </DialogFoot>
      </Dialog>
    </Ctx.Provider>
  );
}

export const useConfirm = (): Ask => useContext(Ctx);
