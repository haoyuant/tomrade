import type { ToolCallInfo, ToolsApi } from "@tomradex/plugin-sdk";
import { authorFor } from "../scope.js";
import { copy, type Facade } from "./shared.js";

export const toolsApi = ({ host, ns }: Facade): ToolsApi => {
  const tools = () => host.svc("tools");
  return {
    register: (tool) =>
      host.call(() => {
        host.own(tool.name, "tool");
        if (tool.kit) host.own(tool.kit, "tool kit");
        const execute = host.back(tool.execute, `tool ${tool.name}`);
        return host.disposerOf(
          tools().register({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            input: tool.input,
            kit: tool.kit,
            execute: (args, inv) => execute(args, { projectId: inv.projectId, runId: inv.run?.id, author: inv.by })
          })
        );
      }),
    kit: (id, purpose) =>
      host.call(() => {
        host.own(id, "tool kit");
        return host.disposerOf(tools().kit(id, purpose));
      }),
    list: () => host.call(() => tools().describe()),
    call: (name, args, opts) => host.call(() => tools().execute(name, args, { by: authorFor(ns), projectId: opts?.projectId })),
    gate: (check) =>
      host.call(() => {
        const run = host.back(check, "tool gate");
        return host.disposerOf(
          host.ctx.on("tools/pre-execute", async (call, next) => {
            // A copy: arguments change only through an `{ args }` answer, which the tool's input checks again.
            const info: ToolCallInfo = { name: call.name, args: copy(call.args), author: call.by, projectId: call.projectId, runId: call.run?.id };
            const answer = await run(info);
            if (answer && typeof answer === "object") {
              if ("result" in answer) return answer.result;
              if ("args" in answer) call.args = answer.args;
            }
            return next();
          })
        );
      })
  };
};
