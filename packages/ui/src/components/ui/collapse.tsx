import { useEffect, useState, type ElementType, type HTMLAttributes, type ReactNode, type TransitionEvent } from "react";
import { motionAllowed } from "~/lib/motion";
import { cn } from "~/lib/utils";

type Phase = "enter" | "exit" | null;

/**
 * What a fold shows while it is open. Opening, it grows from nothing to its height and fades in; closing, it folds
 * back and fades out before it leaves the page. `fade` keeps the height and only fades, for a list long enough that
 * laying it out on every frame would cost. Only a change after the first render moves: content open from the start
 * just shows. Without motion (motion.ts) it appears and goes at once. Styles in motion.css.
 */
export function Collapse({ open, as: Tag = "div", fade, className, children, ...rest }: {
  open: boolean;
  as?: ElementType;
  fade?: boolean;
  className?: string;
  children?: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  const [was, setWas] = useState(open);
  const [present, setPresent] = useState(open);
  const [phase, setPhase] = useState<Phase>(null);
  if (open !== was) {
    setWas(open);
    const moving = motionAllowed();
    if (open) setPresent(true);
    else if (!moving) setPresent(false);
    setPhase(moving ? (open ? "enter" : "exit") : null);
  }
  const settle = () => {
    if (phase === "exit") setPresent(false);
    setPhase(null);
  };
  // A fold with nothing to move fires no transitionend; it settles all the same.
  useEffect(() => {
    if (!phase) return;
    const late = window.setTimeout(() => {
      if (phase === "exit") setPresent(false);
      setPhase(null);
    }, 600);
    return () => window.clearTimeout(late);
  }, [phase]);
  if (!present) return null;
  return (
    // Folding away, it is already gone for the keyboard and the pointer.
    <Tag {...rest} className={cn("collapse", fade && "is-fade", className)} data-phase={phase ?? undefined} inert={phase === "exit" || undefined}
      onTransitionEnd={(event: TransitionEvent<HTMLElement>) => { if (event.target === event.currentTarget && phase) settle(); }}>
      {children}
    </Tag>
  );
}
