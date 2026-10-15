import { definePlugin, defineTool } from "@tomradex/plugin-sdk";
import { z } from "zod";

export default definePlugin({
  inject: ["im", "tools"],
  async apply(ctx) {
    let receive;
    const replies = [];
    await ctx.im.register({
      id: "fake_im", title: "Fake IM",
      capabilities: { edit: true, buttons: true, inboundFiles: false, outboundFiles: false, maxTextLength: 2000, maxFileBytes: 0 },
      async open(_connection, io) {
        receive = io.receive;
        return { deliver: async reply => { replies.push(reply); return { messageId: `m-${replies.length}` }; }, close: () => { receive = undefined; } };
      }
    });
    await ctx.tools.register(defineTool({ name: "fake_im_receive", title: "Send fake message", description: "Feeds this isolated test adapter.",
      input: z.object({ eventId: z.string(), text: z.string(), actor: z.string().default("owner") }),
      execute: async input => {
        if (!receive) throw new Error("Fake adapter is not connected");
        return receive({ kind: "message", eventId: input.eventId, messageId: input.eventId, text: input.text, activation: "dm",
          actor: { id: input.actor, isBot: false }, address: { tenantId: "team", conversationId: "chat" } });
      }
    }));
    await ctx.tools.register(defineTool({ name: "fake_im_replies", title: "Read fake replies", description: "Reads this fixture's messages.",
      input: z.object({}), execute: () => replies }));
  }
});
