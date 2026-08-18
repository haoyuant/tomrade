import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

export function Badge({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
        className,
      )}
    >
      {children}
    </span>
  );
}
