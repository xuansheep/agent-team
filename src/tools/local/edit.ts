import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import { Tool } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

const inputSchema = z.object({ file_path: z.string().min(1), old_string: z.string(), new_string: z.string() });

export const editTool: Tool = {
  name: "Edit",
  description: "Replace one exact string occurrence in a file",
  input_schema: {
    type: "object",
    properties: { file_path: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" } },
    required: ["file_path", "old_string", "new_string"]
  },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const path = resolveWorkspacePath(context.cwd, parsed.file_path);
    const current = await readFile(path, "utf8");
    if (!current.includes(parsed.old_string)) throw new Error(`old_string not found in ${parsed.file_path}`);
    await writeFile(path, current.replace(parsed.old_string, parsed.new_string), "utf8");
    return { output: `Edited ${parsed.file_path}` };
  }
};
