import { defineWords } from "@tomradex/domain";

/** The pet's settings card. */
export const PET_WORDS = defineWords({
  en: {
    title: "Pet",
    description: "An orange-and-white companion that reflects assistant activity. Disable the plugin itself in Manage plugins to unload it completely.",
    enabledTitle: "Enabled",
    enabledDescription: "Show the pet while this plugin is loaded.",
    displayModeTitle: "Display mode",
    displayModeDescription: "Embed above the assistant composer, or float in its own window you can drag anywhere.",
    displayModeEmbedded: "Embedded",
    displayModeDesktop: "On the desktop",
    sizeTitle: "Desktop size",
    sizeSmall: "Small",
    sizeMedium: "Medium",
    sizeLarge: "Large",
    clickThroughTitle: "Transparent click-through",
    clickThroughDescription: "Pass clicks through transparent pixels; drag the opaque cat.",
    allWorkspacesTitle: "All workspaces",
    allWorkspacesDescription: "Keep the desktop pet visible when switching virtual desktops."
  },
  zh: {
    title: "宠物",
    description: "一只橘白相间的小伙伴，跟着助手的活动变换状态。想彻底卸载它，请在“管理插件”里停用这个插件。",
    enabledTitle: "启用",
    enabledDescription: "插件加载时显示宠物。",
    displayModeTitle: "显示方式",
    displayModeDescription: "嵌在助手输入框上方，或者浮在独立的窗口里，可以拖到任何地方。",
    displayModeEmbedded: "嵌入",
    displayModeDesktop: "桌面",
    sizeTitle: "桌面尺寸",
    sizeSmall: "小",
    sizeMedium: "中",
    sizeLarge: "大",
    clickThroughTitle: "透明处点击穿透",
    clickThroughDescription: "点击透明像素会穿透到下面；拖动不透明的猫来移动它。",
    allWorkspacesTitle: "所有桌面",
    allWorkspacesDescription: "切换虚拟桌面时，桌面宠物依然可见。"
  }
});
