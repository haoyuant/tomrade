import type { Context } from "cordis";
import { z } from "zod";
import type {} from "@tomradex/code-link";
import type {} from "@tomradex/items";
import { defineTool, requireProjectId } from "@tomradex/tools";
import type {} from "./service.js";

const ticket = (ctx: Context, projectId: string, key: string) => {
  const item = ctx.items.getByKey(projectId, key);
  if (!item) throw new Error(`unknown ticket ${key}`);
  return item;
};

/** What an agent reviewing a ticket's changes works with: the lines to read, and where its findings go. Neither starts a review. */
export function registerReviewTools(ctx: Context): void {
  ctx.tools.register(
    defineTool({
      name: "read_review_changes",
      kit: "code",
      title: "Read a ticket's changes for review",
      readOnly: true,
      whole: true,
      description:
        "Read what a ticket changed, to review it: its files and their lines, numbered on each side as a finding names them. The answer is for one code link (`linkId` when the ticket has several) and compares its branch with its base, or with `runId` one run of an agent on this machine, as its folder was kept before and after; `unavailable` says that run was not kept whole. With `path`, one file in full.",
      input: z.object({
        key: z.string().min(1).describe("Ticket key, e.g. TOM-42"),
        linkId: z.string().optional().describe("One of the answer's `links`; defaults to the ticket's main one"),
        runId: z.string().optional().describe("One of the answer's `runs`"),
        path: z.string().optional().describe("A changed file, to read every hunk of it"),
        projectId: z.string().optional()
      }),
      execute: async (args, inv) => {
        const projectId = requireProjectId("read_review_changes", args.projectId, inv);
        const item = ticket(ctx, projectId, args.key);
        const opts = { linkId: args.linkId, ...(args.runId ? { scope: { kind: "run" as const, id: args.runId } } : {}) };
        if (!args.path) return ctx.codeLink.changes(projectId, item.id, opts);
        const file = await ctx.codeLink.changeFile(projectId, item.id, { ...opts, path: args.path, full: true });
        // A picture's bytes are for a person's eyes.
        return file?.image ? { ...file, image: undefined } : file;
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "submit_review_findings",
      kit: "code",
      title: "Put review findings on a ticket's diff",
      description:
        "Put the findings of a code review the person asked for on the lines of the ticket's diff, where they read them beside their own comments. Each names its code link, file, side and lines as read_review_changes numbered them, quotes those lines, and says what is wrong. They are shown as yours and reach nobody until the person sends them. One finding without a place refuses them all. This changes no code; report only what you found.",
      input: z.object({
        key: z.string().min(1).describe("Ticket key, e.g. TOM-42"),
        findings: z
          .array(
            z.object({
              linkId: z.string().min(1).describe("The code link whose changes were read"),
              path: z.string().min(1),
              side: z.enum(["old", "new"]).describe("new: a line as the change leaves it; old: a line it removed"),
              line: z.number().int().min(1).describe("The first line, numbered on that side"),
              endLine: z.number().int().min(1).describe("The last line; the same as `line` for one line"),
              quote: z.string().max(20_000).describe("Those lines as they read, so the finding stays with them when the code moves"),
              body: z.string().min(1).max(20_000).describe("What is wrong, and what would put it right"),
              severity: z.enum(["info", "warning", "error"]).describe("error: wrong as it stands; warning: likely to go wrong; info: worth knowing")
            })
          )
          .min(1)
          .max(100),
        projectId: z.string().optional()
      }),
      execute: (args, inv) => {
        const projectId = requireProjectId("submit_review_findings", args.projectId, inv);
        return ctx.changeReview.addFindings(projectId, ticket(ctx, projectId, args.key).id, args.findings, { reviewer: inv.by, ...(inv.run ? { runId: inv.run.id } : {}) });
      }
    })
  );
}
