import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Tool } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

const inputSchema = z.object({ file_path: z.string().min(1) });

export const readTool: Tool = {
  name: "Read",
  description: "Read a UTF-8 text file from the workspace",
  input_schema: { type: "object", properties: { file_path: { type: "string" } }, required: ["file_path"] },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const path = resolveWorkspacePath(context.cwd, parsed.file_path);
    return { output: await readFile(path, "utf8") };
  }
};
