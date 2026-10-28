import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "~/components/icons";
import { logQuietly, messageOf } from "~/lib/api";
import { domainErrorWords } from "~/lib/errors";
import { translate, useI18n } from "~/lib/i18n";

export interface ToastSpec {
  /** Rich body: fragments so an issue key can carry the mono treatment. */
  body: ReactNode;
  /** When set, the toast carries an inline Undo that calls it. */
  onUndo?: () => void;
  /** Choices the toast offers; picking one runs it and dismisses. The X remains a no-op dismiss. */
  actions?: { label: string; run: () => void }[];
  /** Stays until dismissed by its id — for work in progress, not news. */
  sticky?: boolean;
  /** An error reads as one: marked, said assertively, longer-lived, and its words can be copied. */
  tone?: "error";
  /** The words behind an error's translated line, copied along with it. */
  detail?: string;
}

/** An error in the person's view: no IPC wrapper, no class name in front, a domain refusal in their language. */
export const readableError = (error: unknown): string => {
  const raw = messageOf(error);
  const known = domainErrorWords(raw);
  if (known) return translate(known.key, known.vars);
  return raw.replace(/^(?:[A-Z][A-Za-z]*Error): /, "").trim() || raw;
};

/** The toast for a failure: `toast(errorSpec(err))`. */
export const errorSpec = (error: unknown): ToastSpec => {
  const body = readableError(error);
  const raw = messageOf(error);
  return { body, tone: "error", detail: raw.includes(body) ? undefined : raw };
};

/** The mounted toast stack, for failures reported outside it: the language and theme providers sit above it. */
let reporter: ((spec: ToastSpec) => void) | null = null;

/** A failure nobody else reports, as an error toast once a stack is mounted; before that, the console keeps it. */
export const reportError = (error: unknown): void => {
  if (reporter) reporter(errorSpec(error));
  else console.warn(messageOf(error));
};

interface Toast extends ToastSpec {
  id: number;
}

type Push = (t: ToastSpec) => number;
const Ctx = createContext<{ push: Push; dismiss: (id: number) => void }>({ push: () => 0, dismiss: () => {} });

const LIFETIME = 6000;
/** Long enough to read a git error to the end. Hovering or focusing holds either. */
const ERROR_LIFETIME = 15000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const push = useCallback<Push>((spec) => {
    const id = (seq.current += 1);
    setToasts((all) => [...all, { ...spec, id }]);
    return id;
  }, []);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  useEffect(() => {
    const own = (spec: ToastSpec) => void push(spec);
    reporter = own;
    return () => { if (reporter === own) reporter = null; };
  }, [push]);
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
    const timer = window.setTimeout(() => dismiss.current(), toast.tone === "error" ? ERROR_LIFETIME : LIFETIME);
    return () => window.clearTimeout(timer);
  }, [held, toast.sticky, toast.tone]);

  const error = toast.tone === "error";
  return (
    <div
      className={["toast", toast.sticky && "is-sticky", error && "is-error"].filter(Boolean).join(" ")}
      role={error ? "alert" : undefined}
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
      {error && typeof toast.body === "string" && (
        <button
          type="button"
          className="btn btn-icon"
          style={{ padding: 4 }}
          title={t("toast.copy")}
          aria-label={t("toast.copy")}
          onClick={() => void navigator.clipboard?.writeText([toast.body as string, toast.detail].filter(Boolean).join("\n\n")).catch(logQuietly("clipboard"))}
        >
          <Icon name="i-copy" size={12} />
        </button>
      )}
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

/** For hooks whose callers report nothing: a failure still reaches the person. */
export function useErrorToast(): (error: unknown) => void {
  const { push } = useContext(Ctx);
  return useCallback((error: unknown) => void push(errorSpec(error)), [push]);
}
