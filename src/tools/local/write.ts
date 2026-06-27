import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { Tool } from "../types.js";
import { resolveWorkspacePath } from "./path.js";
import { writesSessionPlanFile } from "./planFile.js";

const inputSchema = z.object({ file_path: z.string().min(1), content: z.string() });

export const writeTool: Tool = {
  name: "Write",
  description: "Write a UTF-8 text file in the workspace",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, content: { type: "string" } },
    required: ["file_path", "content"]
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  writesPlanFile: writesSessionPlanFile,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const path = resolveWorkspacePath(context.cwd, parsed.file_path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, parsed.content, "utf8");
    await context.auditSink?.({
      type: "file_write",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: "Write",
      path
    });
    return { output: `Wrote ${parsed.file_path}` };
  }
};
