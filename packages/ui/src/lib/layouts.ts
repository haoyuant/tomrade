import { useMemo } from "react";
import type { LayoutInfo } from "@tomradex/contributions";
import { LAYOUTS, pluginLayout, pluginLayoutId, isBuiltinLayout, type Layout } from "@tomradex/domain";
import type { IconId } from "~/components/icons";
import { LAYOUT_LABEL, layoutIcon } from "./domain";
import { useI18n } from "./i18n";
import { useLayouts } from "./queries";

export interface LayoutOption {
  id: Layout;
  label: string;
  icon: IconId;
  /** Present for a plugin's layout. */
  plugin?: LayoutInfo;
}

/** Every layout a view may take, in the order the switcher shows them: the built-ins, then what plugins contribute. */
export function useLayoutOptions(): LayoutOption[] {
  const { locale } = useI18n();
  const plugins = useLayouts();
  // The built-in labels follow the locale; re-read on its change.
  return useMemo(
    () => [...LAYOUTS.map((id) => ({ id, ...LAYOUT_LABEL[id] })), ...(plugins.data ?? []).map((p) => ({ id: pluginLayout(p.id), label: p.title, icon: layoutIcon(p.icon), plugin: p }))],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- locale changes the built-ins' labels in place
    [plugins.data, locale]
  );
}

/** A layout's name for a view listing: a plugin's whose plugin is off shows its id, so the view is still told apart. */
export const layoutLabel = (layout: Layout, options: LayoutOption[]): string => options.find((o) => o.id === layout)?.label ?? (isBuiltinLayout(layout) ? LAYOUT_LABEL[layout].label : pluginLayoutId(layout));
