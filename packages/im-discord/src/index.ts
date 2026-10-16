import { definePlugin } from "@tomradex/plugin-sdk";
import { CAPABILITIES, openDiscord } from "./adapter.js";

/** Discord over the Gateway: direct messages, @mentions and replies in channels and threads, from this computer. */
export default definePlugin({
  inject: ["im"],
  async apply(ctx) {
    await ctx.im.register({
      id: "discord",
      title: "Discord",
      capabilities: CAPABILITIES,
      setup: {
        fields: [{
          key: "botToken", secret: true, placeholder: "MTEx…",
          label: { en: "Bot token", zh: "机器人令牌（Bot Token）" },
          help: { en: "Bot → Reset Token in the Developer Portal. It is stored encrypted on this computer.", zh: "在开发者后台的 Bot → Reset Token 生成。只加密保存在这台电脑上。" }
        }, {
          key: "messageContent", optional: true, placeholder: "on",
          label: { en: "Read channel messages (optional)", zh: "读取频道消息（可选）" },
          help: { en: "Type on only after turning on Message Content Intent in the portal; otherwise Discord refuses the connection. Needed for a group's recent-discussion window.", zh: "先在开发者后台打开 Message Content Intent，再在这里填 on；没打开就填会被 Discord 拒绝连接。群聊的「最近讨论」窗口需要它。" }
        }],
        steps: [
          { en: "Open the Discord Developer Portal and create a **New Application**.", zh: "打开 Discord 开发者后台，点 **New Application** 新建应用。" },
          { en: "In **Bot**, press **Reset Token** and copy it into the field below. Privileged intents can stay off: mentions and direct messages carry their text without Message Content.", zh: "在 **Bot** 页点 **Reset Token**，把令牌复制到下面。特权 Intent 都可以不开：@ 机器人和私信本身就带正文，不需要 Message Content。" },
          { en: "In **Installation**, keep Guild Install with the scopes `bot` and `applications.commands` and the permissions listed here, then open the install link and add the bot to your server.", zh: "在 **Installation** 里保留 Guild Install，勾选 `bot` 和 `applications.commands` 两个 scope 以及下面列出的权限，然后打开安装链接把机器人加到你的服务器。" },
          { en: "Optional: to let the assistant see a channel's recent discussion when @mentioned, turn on **Message Content Intent** under **Bot**, type `on` in the optional field below, and turn on the window for that group in its route. Off by default; the messages stay on this computer.", zh: "可选：想让助手被 @ 时看到频道最近的讨论，在 **Bot** 页打开 **Message Content Intent**，在下面的可选字段填 `on`，再在该群的路由里打开上下文窗口。默认关闭；消息只保存在这台电脑上。" },
          { en: "Save and connect. Then send the bot a direct message with the pairing code from Tomrade, and @mention it in a channel to use it there.", zh: "保存并连接。然后私信机器人发送 Tomrade 里的配对码；在频道里 @ 它即可在频道使用。" }
        ],
        permissions: ["View Channels", "Send Messages", "Send Messages in Threads", "Read Message History", "Embed Links", "Attach Files", "Add Reactions"],
        docsUrl: "https://discord.com/developers/applications"
      },
      open: (connectionId, io) => openDiscord(connectionId, io)
    });
  }
});
