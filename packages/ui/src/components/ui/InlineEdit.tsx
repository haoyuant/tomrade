import { useRef, type InputHTMLAttributes } from "react";
import { isCancelKey, isCommitKey } from "~/lib/keys";

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "defaultValue" | "onKeyDown" | "onBlur" | "onFocus"> & {
  value: string;
  /** An emptied field is a value too (a cleared field, a path back to the root), not a cancelled edit. */
  allowEmpty?: boolean;
  onSave: (next: string) => void;
};

/**
 * A one-line edit in place: Enter and blur commit, Escape restores. Enter
 * commits directly rather than through blur, because an unfocused window fires
 * no focus events at all; an Enter that picks an IME candidate commits nothing.
 */
export function InlineEdit({ value, allowEmpty, onSave, className, ...rest }: Props) {
  const settled = useRef(false);
  const commit = (el: HTMLInputElement) => {
    if (settled.current) return;
    settled.current = true;
    const next = el.value.trim();
    if (next !== value && (next || allowEmpty)) onSave(next);
    else el.value = value;
  };
  return (
    <input
      key={value}
      {...rest}
      className={className ?? "input"}
      defaultValue={value}
      onFocus={() => {
        settled.current = false;
      }}
      onKeyDown={(e) => {
        if (isCancelKey(e)) {
          e.stopPropagation();
          e.currentTarget.value = value;
          settled.current = true;
          e.currentTarget.blur();
        }
        if (isCommitKey(e)) {
          e.preventDefault();
          commit(e.currentTarget);
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => commit(e.currentTarget)}
    />
  );
}
