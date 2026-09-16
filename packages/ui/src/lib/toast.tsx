import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "~/components/icons";
import { useI18n } from "~/lib/i18n";

export interface ToastSpec {
  /** Rich body: fragments so an issue key can carry the mono treatment. */
  body: ReactNode;
  /** When set, the toast carries an inline Undo that calls it. */
  onUndo?: () => void;
  /** Choices the toast offers; picking one runs it and dismisses. The X remains a no-op dismiss. */
  actions?: { label: string; run: () => void }[];
  /** Stays until dismissed by its id — for work in progress, not news. */
  sticky?: boolean;
}

interface Toast extends ToastSpec {
  id: number;
}

type Push = (t: ToastSpec) => number;
const Ctx = createContext<{ push: Push; dismiss: (id: number) => void }>({ push: () => 0, dismiss: () => {} });

const LIFETIME = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback<Push>((spec) => {
    const id = (seq.current += 1);
    setToasts((all) => [...all, { ...spec, id }]);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const value = useMemo(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite" aria-atomic="false">
        {toasts.map((t) => (
          <ToastRow key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

/**
 * The countdown holds while the toast is hovered or holds focus — an Undo
 * button that expires while you are tabbing to it is not an affordance.
 */
function ToastRow({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const { t } = useI18n();
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (held || toast.sticky) return;
    const timer = window.setTimeout(() => dismiss.current(), LIFETIME);
    return () => window.clearTimeout(timer);
  }, [held, toast.sticky]);

  return (
    <div
      className={toast.sticky ? "toast is-sticky" : "toast"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="ribbon-tick" />
      <span className="toast-body" style={{ flex: 1, lineHeight: "var(--leading-dense)" }}>{toast.body}</span>
      {toast.onUndo && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: "3px 9px", fontSize: "var(--text-xs)" }}
          onClick={() => {
            toast.onUndo?.();
            dismiss.current();
          }}
        >
          <Icon name="i-undo" size={12} /> {t("toast.undo")}
        </button>
      )}
      {toast.actions?.map((action) => (
        <button
          key={action.label}
          type="button"
          className="btn btn-ghost"
          style={{ padding: "3px 9px", fontSize: "var(--text-xs)" }}
          onClick={() => {
            action.run();
            dismiss.current();
          }}
        >
          {action.label}
        </button>
      ))}
      <button
        type="button"
        className="btn btn-icon"
        style={{ padding: 4 }}
        title={t("toast.dismiss")}
        aria-label={t("toast.dismissAria")}
        onClick={() => dismiss.current()}
      >
        <Icon name="i-close" size={12} />
      </button>
    </div>
  );
}

export const useToast = (): Push => useContext(Ctx).push;

/** For a toast that reports work in progress: put it up, take it down when the work is done. */
export const useToastDismiss = () => useContext(Ctx).dismiss;
