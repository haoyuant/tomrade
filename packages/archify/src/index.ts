export { ArchifyRuntime, ARCHIFY_REVISION, diagramTypes, type DiagramType } from "./runtime.js";
import type {} from "cordis";
import type { Context } from "cordis";
import type {} from "@tomradex/agent";
import type { Files } from "@tomradex/files";
import { defineTool } from "@tomradex/tools";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { unplaced } from "./layout.js";
import { ArchifyRuntime, diagramTypes } from "./runtime.js";

export const Config = z.object({
  cacheDirectory: z.string().default(path.join(os.homedir(), ".cache", "tomrade", "archify")),
  nodeBinary: z.string().default(process.execPath)
});

export default {
  name: "archify",
  inject: ["agent", "tools"],
  Config,
  apply(ctx: Context, config: z.infer<typeof Config>) {
    const runtime = new ArchifyRuntime(config.cacheDirectory, config.nodeBinary);
    // Failed renders per run. A placement that is still failing on the third try was never going
    // to end in a diagram; from there the renderer lays it out instead.
    const failures = new Map<string, number>();
    ctx.agent.playbook({
      id: "diagram.archify", title: "System diagrams",
      when: "Create architecture, workflow, sequence, data-flow or lifecycle diagrams from a description or known source facts.",
      workTypes: ["general", "coding"], requires: ["diagram.render", "files.write"], outputs: ["application/json", "text/html"],
      tools: ["diagram_schema", "diagram_render", "diagram_export", "ask_user"],
      body: [
        "Choose architecture, workflow, sequence, dataflow, or lifecycle. This method creates technical system diagrams, not statistical charts or generated photographs.",
        "Read diagram_schema for the selected type, including schema, common definitions and example. Examples show structure only; use the user's actual facts and fresh IDs.",
        "Author a JSON specification with one main path, at most 12 primary nodes, short labels and automatic routes. Set meta.quality_profile to showcase. Use workflow schema_version 2 for new workflows.",
        "Call diagram_render with the specification. This always creates two complete artifacts: editable source JSON and the full rendered HTML, then displays the HTML in this conversation. The tool installs the pinned runtime if needed; no shell or separate agent skill installation is required.",
        "On failure, use diagnostics to repair only the identified subjects using supportedFixes; retry while the best error count improves. Stop after two consecutive repairs without improvement and report the diagnostics.",
        "For architecture, when your own placement still fails after two repairs, send the same components, boundaries, connections and cards once more with every coordinate and route control left out (pos, size, row, col, layout, viewBox, via, sides, label positions): diagram_render then lays it out itself. A result with layout \"automatic\" and quality \"standard\" kept a few crossings or tight labels that showcase rejects; say so in one line.",
        "On success, call ask_user before exporting: offer the agent-recommended directory `diagrams/<short-slug>` or let the user provide a directory under Files. Explain that export writes both `diagram.json` and the complete `diagram.html` there. After the answer, call diagram_export with the two media IDs returned by diagram_render and the chosen directory. Do not claim export succeeded until diagram_export returns both file versions.",
        "Validation proves schema/layout checks, not source accuracy or visual review. Do not claim browser review unless it actually happened. Ask for missing system facts or inspect available source tools before asserting actual repository architecture."
      ].join("\n")
    });
    ctx.effect(() => ctx.agent.capability("diagram.render"));
    ctx.tools.register(defineTool({
      name: "diagram_schema", title: "Read diagram schema",
      description: "Read Archify's JSON schema, shared definitions or one example for a system diagram. Fetch all three resources before authoring. Installs the pinned Archify runtime on first use.",
      input: z.object({ type: z.enum(diagramTypes), resource: z.enum(["schema", "common", "example"]) }),
      execute: async ({ type, resource }) => {
        const data = await runtime.schema(type);
        return { type, resource, revision: data.revision, content: data[resource] };
      }
    }));
    ctx.tools.register(defineTool({
      name: "diagram_render", title: "Render a system diagram",
      description: "Validate an Archify JSON specification and display its interactive HTML diagram in the conversation. Returns a media reference on success or repair diagnostics on failure. No Files save occurs until requested.",
      input: z.object({ type: z.enum(diagramTypes), spec: z.record(z.string(), z.unknown()), title: z.string().min(1).max(180) }),
      execute: async ({ type, spec, title }, inv) => {
        if (!inv.run) throw new Error("Diagram rendering requires an active agent conversation");
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), "tomrade-diagram-"));
        try {
          const signal = ctx.agent.runSignal(inv.run.id);
          let result = await runtime.render(type, spec, directory, signal);
          if (!result.ok && type === "architecture") {
            const failed = (failures.get(inv.run.id) ?? 0) + 1;
            failures.set(inv.run.id, failed);
            if (failed >= 3 && !unplaced(spec)) {
              const arranged = await runtime.render(type, spec, path.join(directory, "automatic"), signal, { arrange: true });
              if (arranged.ok) result = arranged;
            }
          }
          if (!result.ok) return result;
          failures.delete(inv.run.id);
          const source = ctx.agent.uploadMedia(inv.run.projectId, inv.run.threadId, {
            name: "diagram.json", mime: "application/json", base64: (await fs.readFile(result.source)).toString("base64")
          });
          const media = ctx.agent.publishMedia(inv.run.id, {
            name: `${title.replace(/[\\/]/g, "-")}.html`, mime: "text/html",
            base64: (await fs.readFile(result.artifact)).toString("base64")
          }, title, source);
          const placement = "layout" in result ? { layout: result.layout, quality: result.quality, ...(result.showcaseIssues ? { showcaseIssues: result.showcaseIssues } : {}) } : {};
          return { ok: true, media, source, ...placement, revision: result.revision, receipt: result.receipt, browserReview: "not performed" };
        } finally { await fs.rm(directory, { recursive: true, force: true }); }
      }
    }));
    ctx.tools.register(defineTool({
      name: "diagram_export", title: "Export diagram artifacts to Files",
      description: "Write the complete rendered HTML and its editable source JSON from a successful diagram_render call into a project Files directory. Use only the media IDs returned by diagram_render; never recreate or truncate the HTML.",
      input: z.object({
        htmlMediaId: z.string().min(1), sourceMediaId: z.string().min(1),
        directory: z.string().min(1).max(240).describe("Directory relative to the project Files root, e.g. diagrams/system-overview")
      }),
      execute: async ({ htmlMediaId, sourceMediaId, directory }, inv) => {
        if (!inv.run) throw new Error("Diagram export requires an active agent conversation");
        const files = ctx.get("files") as Files | undefined;
        if (!files) throw new Error("Files storage is not installed; diagram export is unavailable");
        const projectId = inv.run.projectId;
        const threadId = inv.run.threadId;
        const html = ctx.agent.readMedia(projectId, threadId, htmlMediaId);
        const source = ctx.agent.readMedia(projectId, threadId, sourceMediaId);
        if (html.mime !== "text/html") throw new Error("htmlMediaId does not reference a rendered HTML artifact");
        if (source.mime !== "application/json") throw new Error("sourceMediaId does not reference diagram JSON");
        const clean = directory.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
        if (!clean || clean.split("/").some(segment => !segment || segment === "." || segment === ".." || segment.startsWith("."))) throw new Error("directory must be a visible relative Files directory");
        const htmlFile = await files.write(projectId, `${clean}/diagram.html`, Buffer.from(html.base64, "base64"), { message: "Export complete Archify HTML diagram" });
        const sourceFile = await files.write(projectId, `${clean}/diagram.json`, Buffer.from(source.base64, "base64"), { message: "Export editable Archify diagram source" });
        return { ok: true, directory: clean, html: { path: htmlFile.path, fileId: htmlFile.fileId, versionId: htmlFile.versionId, size: htmlFile.size }, source: { path: sourceFile.path, fileId: sourceFile.fileId, versionId: sourceFile.versionId, size: sourceFile.size } };
      }
    }));
  }
};
