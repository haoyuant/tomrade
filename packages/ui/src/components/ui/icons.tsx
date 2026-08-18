/**
 * Inline SVG icon set (lucide-style paths, no dependency).
 * All icons accept className for sizing/coloring via Tailwind.
 */
import type { ReactNode } from "react";

function base(children: ReactNode, className?: string) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "h-4 w-4"}
    >
      {children}
    </svg>
  );
}

export function SunIcon({ className }: { className?: string }) {
  return base(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
    </>,
    className
  );
}

export function MoonIcon({ className }: { className?: string }) {
  return base(<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />, className);
}

export function MonitorIcon({ className }: { className?: string }) {
  return base(
    <>
      <rect width="18" height="12" x="3" y="4" rx="2" />
      <path d="M12 16v4m-4 0h8" />
    </>,
    className
  );
}

export function PlusIcon({ className }: { className?: string }) {
  return base(<path d="M12 5v14m-7-7h14" />, className);
}

export function UndoIcon({ className }: { className?: string }) {
  return base(
    <>
      <path d="M3 7v6h6" />
      <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </>,
    className
  );
}

export function SettingsIcon({ className }: { className?: string }) {
  return base(
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>,
    className
  );
}

export function TrashIcon({ className }: { className?: string }) {
  return base(
    <>
      <path d="M3 6h18" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    </>,
    className
  );
}

export function CloseIcon({ className }: { className?: string }) {
  return base(<path d="M18 6 6 18M6 6l12 12" />, className);
}

export function BackIcon({ className }: { className?: string }) {
  return base(
    <>
      <path d="M19 12H5" />
      <path d="m12 19-7-7 7-7" />
    </>,
    className
  );
}

export function SparklesIcon({ className }: { className?: string }) {
  return base(
    <>
      <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
      <path d="M20 3v4m-2-2h4" />
    </>,
    className
  );
}

export function ChevronRightIcon({ className }: { className?: string }) {
  return base(<path d="m9 18 6-6-6-6" />, className);
}
