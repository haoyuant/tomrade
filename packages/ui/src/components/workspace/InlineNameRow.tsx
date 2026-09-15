import { Icon, type IconId } from "~/components/icons";

/** One inline name field, shared by the sidebar's "new …" rows. */
export function InlineNameRow({ icon, ariaLabel, placeholder, onCommit, onCancel }: { icon: IconId; ariaLabel: string; placeholder: string; onCommit: (name: string) => void; onCancel: () => void }) {
  return (
    <div className="side-row is-view" style={{ cursor: "default", background: "var(--surface)", boxShadow: "var(--elev-ring)" }}>
      <Icon className="ico" name={icon} size={15} />
      <input
        autoFocus
        aria-label={ariaLabel}
        placeholder={placeholder}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          background: "transparent",
          padding: 0,
          color: "var(--fg)",
          fontFamily: "var(--font-display)",
          fontSize: 14,
          outline: "none"
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
          if (e.key === "Enter") onCommit(e.currentTarget.value);
        }}
        onBlur={(e) => {
          if (!e.currentTarget.value.trim()) onCancel();
        }}
      />
    </div>
  );
}
