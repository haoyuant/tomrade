import type { Context } from "cordis";
import { Boards } from "./boards.js";
import { Views } from "./views.js";
import { registerChannels, registerTools } from "./contributions.js";

export { Boards, Views };
export type {} from "./contributions.js";

/** One row in tomrade.yml provides both keys: workstreams are a field, views are how the project looks at its fields. */
export const boards = {
  name: "boards",
  inject: ["db", "oplog"],
  async apply(ctx: Context) {
    await ctx.plugin(Boards);
    await ctx.plugin(Views);
    ctx.inject(["tools", "boards", "db"], registerTools);
    ctx.inject(["ipc", "boards", "views"], registerChannels);
  }
};

export default boards;
