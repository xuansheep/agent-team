import { access } from "node:fs/promises";
import { basename } from "node:path";
import { z } from "zod";
import { Tool } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

const inputSchema = z.object({ path: z.string().min(1), artifact_id: z.string().optional() });

export const attachImageTool: Tool = {
  name: "AttachImage",
  description: "Attach a local image path or image artifact to the model context",
  input_schema: { type: "object", properties: { path: { type: "string" }, artifact_id: { type: "string" } }, required: ["path"] },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const path = resolveWorkspacePath(context.cwd, parsed.path);
    await access(path);
    return { output: `Attached image ${parsed.path}`, artifact_id: parsed.artifact_id ?? `input/${basename(path)}` };
  }
};
