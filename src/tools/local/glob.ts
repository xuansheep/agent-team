import fg from "fast-glob";
import { z } from "zod";
import { Tool } from "../types.js";

const inputSchema = z.object({ pattern: z.string().min(1) });

export const globTool: Tool = {
  name: "Glob",
  description: "Find files by glob pattern in the workspace",
  input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const matches = await fg(parsed.pattern, { cwd: context.cwd, dot: true, onlyFiles: false });
    return { output: matches.join("\n") };
  }
};
