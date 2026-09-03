export const fieldsDialog = {
  en: {
    dialogLabel: "Fields",
    headTitle: "Fields",
    builtinEyebrow: "Built-in",
    builtinNote: "Every project has these. Their names are fixed; a view can filter, sort and group by them like any other field.",
    customEyebrow: "Custom fields",
    noCustomYet: "No custom fields yet. Add one below — it appears on every issue in the project.",
    valuesOne: "{{n}} issue",
    valuesMany: "{{n}} issues",
    selectHint: "Select a custom field to rename it, manage its options or delete it.",

    newFieldEyebrow: "New field",
    newFieldNamePlaceholder: "Field name",
    newFieldNameAria: "New field name",
    newFieldTypeAria: "New field type",
    addField: "Add field",
    createdToast: "Added {{name}}",

    nameLabel: "Name",
    typeLabel: "Type",
    renamedToast: "Renamed to {{name}}",

    optionsEyebrow: "Options",
    optionNameAria: "Option name",
    optionDescriptionPlaceholder: "Description (optional)",
    optionDescriptionAria: "Option description",
    newOptionPlaceholder: "New option…",
    newOptionAria: "New option name",
    addOption: "Add option",
    removeOptionTitle: "Remove {{name}} — issues holding it are cleared",
    removeOptionAria: "Remove option {{name}}",
    removedOptionToast: "Removed {{name}} and cleared it on {{n}} issues",
    noOptionsYet: "No options yet. An issue cannot hold this field until it has one.",

    deleteField: "Delete field",
    deleteWarningOne: "Takes its value on {{n}} issue with it. There is no undo for this.",
    deleteWarningMany: "Takes its values on {{n}} issues with it. There is no undo for this.",
    deleteWarningNone: "No issue carries a value yet, so nothing else goes with it.",
    confirmDelete: "Delete {{name}}",
    deletedToast: "Deleted {{name}}",

    close: "Close"
  },
  zh: {
    dialogLabel: "字段",
    headTitle: "字段",
    builtinEyebrow: "内置字段",
    builtinNote: "每个项目都有这些字段。名称固定；视图可以像其它字段一样按它们筛选、排序和分组。",
    customEyebrow: "自定义字段",
    noCustomYet: "尚无自定义字段。在下方添加一个，它会出现在项目的每个工作项上。",
    valuesOne: "{{n}} 个工作项",
    valuesMany: "{{n}} 个工作项",
    selectHint: "选择一个自定义字段以重命名、管理选项或删除。",

    newFieldEyebrow: "新建字段",
    newFieldNamePlaceholder: "字段名称",
    newFieldNameAria: "新字段名称",
    newFieldTypeAria: "新字段类型",
    addField: "添加字段",
    createdToast: "已添加 {{name}}",

    nameLabel: "名称",
    typeLabel: "类型",
    renamedToast: "已重命名为 {{name}}",

    optionsEyebrow: "选项",
    optionNameAria: "选项名称",
    optionDescriptionPlaceholder: "说明（可选）",
    optionDescriptionAria: "选项说明",
    newOptionPlaceholder: "新选项…",
    newOptionAria: "新选项名称",
    addOption: "添加选项",
    removeOptionTitle: "移除 {{name}}——持有它的工作项会被清空",
    removeOptionAria: "移除选项 {{name}}",
    removedOptionToast: "已移除 {{name}}，并清空了 {{n}} 个工作项上的该值",
    noOptionsYet: "尚无选项。字段至少有一个选项后，工作项才能持有它。",

    deleteField: "删除字段",
    deleteWarningOne: "会带走 {{n}} 个工作项上的值。此操作不可撤销。",
    deleteWarningMany: "会带走 {{n}} 个工作项上的值。此操作不可撤销。",
    deleteWarningNone: "尚无工作项持有该字段的值，不会带走其它任何内容。",
    confirmDelete: "删除 {{name}}",
    deletedToast: "已删除 {{name}}",

    close: "关闭"
  }
};
