import type { ReactNode } from "react";

/** A section of the Appearance pane, one step below the pane's own heading; its tag sits by its title, apart from the pane's. */
export function AppearanceGroupHead({ title, aside, children }: { title: string; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="appearance-group-head">
      <div className="appearance-group-title-row">
        <h4 className="appearance-group-title">{title}</h4>
        {aside}
      </div>
      {children && <p className="appearance-group-lede">{children}</p>}
    </div>
  );
}
