import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Tool } from "../types.js";
import { resolvePlanAwareWritePath, writesSessionPlanFile } from "./planFile.js";

const editSchema = z.object({ old_string: z.string(), new_string: z.string() });
const inputSchema = z.object({ file_path: z.string().min(1), edits: z.array(editSchema).min(1) });

export const multiEditTool: Tool = {
  name: "MultiEdit",
  description: "Apply ordered exact string replacements in a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, edits: { type: "array" } },
    required: ["file_path", "edits"]
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  writesPlanFile: writesSessionPlanFile,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const path = resolvePlanAwareWritePath(context, parsed.file_path);
    let next = await readFile(path, "utf8");
    for (const edit of parsed.edits) {
      if (!next.includes(edit.old_string)) throw new Error(`old_string not found in ${parsed.file_path}`);
      next = next.replace(edit.old_string, edit.new_string);
    }
    await writeFile(path, next, "utf8");
    await context.auditSink?.({
      type: "file_write",
      session_id: context.sessionId,
      run_id: context.runId,
      node_id: context.nodeId,
      attempt: context.attempt,
      tool: "MultiEdit",
      path
    });
    return { output: `Applied ${parsed.edits.length} edits to ${parsed.file_path}` };
  }
};
