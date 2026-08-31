export const pluginsPanel = {
  en: {
    stateRunning: "running",
    stateWaiting: "waiting",
    stateFailed: "failed",
    stateOff: "off",

    waitingFor: "Waiting for {{list}}",
    waitingForFallback: "a service that never arrived",
    provides: "Provides {{list}}",
    needs: "needs {{list}}",
    addsNothing: "Adds to what is already there — it provides no service of its own",

    colModule: "Module",
    colProvidedBy: "Provided by",
    colKind: "Kind",
    required: "Required",
    optional: "Optional",
    nothing: "nothing",

    holdsTag: "holds {{list}}",
    holdsWhy: "The only plugin providing {{list}}. Add another provider before switching it off.",
    enableAria: "Enable {{id}}",

    modulesTitle: "Modules",
    modulesLede:
      "A module is a capability, named by the service key that carries it. Which plugin fills one is never declared — it is read off the running context, so a plugin that loads further plugins is credited with what they provide. A required module may not be left empty.",
    nothingProvides: "Nothing provides {{list}}. The app is running without {{pronoun}}.",
    pronounIt: "it",
    pronounThem: "them",

    installedTitle: "Installed",
    runningOfTotal: "{{running}} of {{total}} running",
    installedLede:
      "One row per plugin, in the order the composition lists them. A switch takes effect at once: the plugin unloads with its tools, channels, badges and settings panes, and everything that injected it goes too. The choice is written to your patch file, so it survives a restart. A plugin that holds up a required module on its own has no switch to throw — the module would be left empty.",
    emptyRows: "Nothing to show — the composition has not been read.",

    addingTitle: "Adding one",
    notFromHereYet: "Not from here — yet",
    addingBullet1: "A plugin is a row in {{yml}}, or in your own {{patchYml}}, which may add rows the app does not ship.",
    addingBullet2:
      "Swapping the plugin behind a required module is a change of {{name}} on its row: a service key has one owner, so a replacement cannot be switched on beside the plugin it replaces.",
    addingBullet3: "Browsing and installing from here is a later thing. This pane manages what is already listed."
  },
  zh: {
    stateRunning: "运行中",
    stateWaiting: "等待中",
    stateFailed: "已失败",
    stateOff: "已关闭",

    waitingFor: "正在等待 {{list}}",
    waitingForFallback: "一个始终没有出现的服务",
    provides: "提供 {{list}}",
    needs: "依赖 {{list}}",
    addsNothing: "为已有的能力做补充——它本身不提供任何服务",

    colModule: "模块",
    colProvidedBy: "提供方",
    colKind: "类型",
    required: "必需",
    optional: "可选",
    nothing: "无",

    holdsTag: "承载 {{list}}",
    holdsWhy: "这是唯一提供 {{list}} 的插件。请先添加另一个提供方，再关闭它。",
    enableAria: "启用 {{id}}",

    modulesTitle: "模块",
    modulesLede: "模块是一种能力，以承载它的服务键命名。由哪个插件填充某个模块从不会显式声明——而是从运行时上下文中读出，因此一个加载了其他插件的插件，会被记为提供了它们所提供的一切。必需模块不允许留空。",
    nothingProvides: "没有任何插件提供 {{list}}。应用目前是在缺少{{pronoun}}的情况下运行的。",
    pronounIt: "它",
    pronounThem: "它们",

    installedTitle: "已安装",
    runningOfTotal: "{{total}} 个中有 {{running}} 个在运行",
    installedLede: "每个插件占一行，顺序与组合文件中一致。开关会立即生效：该插件连同它的工具、通道、徽标与设置面板一起卸载，依赖它的一切也随之卸载。这个选择会写入你的补丁文件，重启后依然有效。若某个插件独自撑起了一个必需模块，它就没有可以关闭的开关——关闭会让该模块留空。",
    emptyRows: "没有可显示的内容——尚未读取组合文件。",

    addingTitle: "添加新插件",
    notFromHereYet: "暂不支持在此处添加",
    addingBullet1: "插件是 {{yml}} 中的一行，或者写在你自己的 {{patchYml}} 里，用来添加应用本身未附带的行。",
    addingBullet2: "更换某个必需模块背后的插件，就是修改该行的 {{name}}：一个服务键只能有一个所有者，所以替代品不能与被替代的插件同时开启。",
    addingBullet3: "从这里浏览与安装插件是以后才会有的功能。当前这个面板只管理已经列出的插件。"
  }
};
