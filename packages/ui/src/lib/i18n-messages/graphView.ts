export const graphView = {
  en: {
    linkedToast: "{{from}} now blocks {{to}}",
    unlinkedToast: "{{from}} no longer blocks {{to}}",
    editHint: "Drag from a card's right edge to the one it blocks · select an arrow and press ⌫ to cut it",
    readOnlyHint: "This graph is read-only.",
    fit: "Fit",
    updateDeps: "Update dependencies",
    updateDepsHint: "Ask the assistant to recheck the dependencies between tickets",
    updateDepsPrompt: "Recheck the dependencies between all tickets and update the ones that are missing or wrong.",
    exportImage: "Export image",
    exportTitle: "Export the graph as an image",
    exported: "Graph image saved",
    showSettled: "Show {{n}} settled",
    hideSettled: "Hide {{n}} settled",
    settledHint: "Done or cancelled tickets, and tickets whose every dependency is already done or cancelled",
    empty: "Nothing to draw — the filters left no tickets in this view.",
    noGraph: "No plugin contributes a graph. Enable one, such as Dependencies, in Plugins."
  },
  zh: {
    linkedToast: "{{from}} 现在阻塞 {{to}}",
    unlinkedToast: "{{from}} 不再阻塞 {{to}}",
    editHint: "从卡片右缘拖到它所阻塞的卡片即可连线 · 选中箭头后按 ⌫ 删除",
    readOnlyHint: "此关系图为只读。",
    fit: "适应画布",
    updateDeps: "更新依赖",
    updateDepsHint: "让助手重新检查工单之间的依赖",
    updateDepsPrompt: "重新检查所有工单之间的依赖关系，补上缺失的、改正错误的。",
    exportImage: "导出图片",
    exportTitle: "将关系图导出为图片",
    exported: "关系图图片已保存",
    showSettled: "显示 {{n}} 张已了结",
    hideSettled: "隐藏 {{n}} 张已了结",
    settledHint: "已完成或已取消的工单，以及依赖全部已完成或已取消的工单",
    empty: "没有可绘制的内容——筛选没有在此视图留下任何工单。",
    noGraph: "没有插件提供关系图。请在「插件」中启用一个，例如「依赖关系」。"
  }
};
