import { readdir } from "node:fs/promises";
import { z } from "zod";
import { Tool } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

const inputSchema = z.object({ path: z.string().default(".") });

export const lsTool: Tool = {
  name: "LS",
  description: "List directory entries in the workspace",
  input_schema: { type: "object", properties: { path: { type: "string" } } },
  async execute(input, context) {
    const parsed = inputSchema.parse(input ?? {});
    const path = resolveWorkspacePath(context.cwd, parsed.path);
    const entries = await readdir(path, { withFileTypes: true });
    return { output: entries.map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n") };
  }
};
