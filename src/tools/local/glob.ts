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
    const pattern = normalizeGlobPatternForFastGlob(parsed.pattern);
    const matches = await fg(pattern, { cwd: context.cwd, dot: true, onlyFiles: false });
    return { output: matches.join("\n") };
  }
};

export function normalizeGlobPatternForFastGlob(pattern: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? pattern.replace(/\\/g, "/") : pattern;
}
