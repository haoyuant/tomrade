import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "~/components/icons";

export interface ToastSpec {
  /** Rich body: fragments so an issue key can carry the mono treatment. */
  body: ReactNode;
  /** When set, the toast carries an inline Undo that calls it. */
  onUndo?: () => void;
}

interface Toast extends ToastSpec {
  id: number;
}

const Ctx = createContext<(t: ToastSpec) => void>(() => {});

const LIFETIME = 6000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback((spec: ToastSpec) => {
    const id = (seq.current += 1);
    setToasts((all) => [...all, { ...spec, id }]);
  }, []);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);

  return (
    <Ctx.Provider value={push}>
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
  const [held, setHeld] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;

  useEffect(() => {
    if (held) return;
    const timer = window.setTimeout(() => dismiss.current(), LIFETIME);
    return () => window.clearTimeout(timer);
  }, [held]);

  return (
    <div
      className="toast"
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={() => setHeld(false)}
    >
      <span className="ribbon-tick" />
      <span style={{ flex: 1, lineHeight: "var(--leading-dense)" }}>{toast.body}</span>
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
          <Icon name="i-undo" size={12} /> Undo
        </button>
      )}
    </div>
  );
}

export const useToast = () => useContext(Ctx);
