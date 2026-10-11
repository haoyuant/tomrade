export const hubPane = {
  en: {
    title: "Hub",
    lede: "The folder your projects, playbooks and settings live in. Give it a remote and a second machine becomes this one.",
    folderLabel: "Hub folder",
    folderNote: "New projects get a folder under projects/; playbooks and your own settings live here too.",
    cloudLede: "Your account keeps the project catalog and preferences in sync. This folder holds local projects and files.",
    cloudFolderNote: "New project folders are created under projects/. Their local paths are private to this machine.",
    reveal: "Reveal",

    remoteLabel: "Remote",
    remoteNone: "Not published anywhere yet",
    remoteKindLabel: "Where it is published",
    remoteDescFallback: "Pick a kind of remote to publish the Hub to.",
    noRemoteOption: "Nowhere",
    publishHere: "Publish here",
    publishing: "Publishing…",
    publishedToast: "Hub published to {{location}}",
    changeRemote: "Change…",
    forgetRemote: "Forget remote",
    forgetting: "Forgetting…",
    forgotToast: "The Hub's remote is forgotten. Nothing there was deleted.",
    boundNote: "Tomrade commits the Hub folder and pushes it. Projects with a repository of their own are ignored here and travel by themselves.",
    cancel: "Cancel",

    stateLabel: "State",
    syncNow: "Sync now",
    syncing: "Syncing…",
    syncedToast: "Hub {{label}} · {{location}}",

    scopeMachine: "This machine",
    scopeUser: "Follows the Hub"
  },
  zh: {
    title: "主目录",
    lede: "你的项目、playbook 和设置所在的文件夹。给它一个远端，第二台机器就能变成这一台。",
    folderLabel: "主目录",
    folderNote: "新项目的文件夹放在 projects/ 下；playbook 和你自己的设置也在这里。",
    cloudLede: "账号同步项目目录和用户偏好。这个文件夹存放本机的项目与文件。",
    cloudFolderNote: "新项目的文件夹放在 projects/ 下，本地路径仅保留在这台机器上。",
    reveal: "在访达中显示",

    remoteLabel: "远端",
    remoteNone: "尚未发布到任何地方",
    remoteKindLabel: "发布到哪里",
    remoteDescFallback: "选择一种远端来发布主目录。",
    noRemoteOption: "不发布",
    publishHere: "发布到这里",
    publishing: "发布中…",
    publishedToast: "主目录已发布到 {{location}}",
    changeRemote: "更换…",
    forgetRemote: "忘记远端",
    forgetting: "正在忘记…",
    forgotToast: "已忘记主目录的远端。远端上的内容未被删除。",
    boundNote: "Tomrade 会提交主目录文件夹并推送。拥有自己仓库的项目在这里被忽略，各自同步。",
    cancel: "取消",

    stateLabel: "状态",
    syncNow: "立即同步",
    syncing: "同步中…",
    syncedToast: "主目录 {{label}} · {{location}}",

    scopeMachine: "仅本机",
    scopeUser: "随主目录"
  }
};
