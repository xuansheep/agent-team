import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { z } from "zod";
import { resolve } from "node:path";
import { assertGlobInsideWorkspace, isPathInsideOrSame } from "../../security/pathBoundary.js";
import { Tool } from "../types.js";

const inputSchema = z.object({ pattern: z.string().min(1), glob: z.string().default("**/*") });
const maxRows = 1000;

export const grepTool: Tool = {
  name: "Grep",
  description: "Search UTF-8 text files by substring or regular expression",
  input_schema: {
    type: "object",
    properties: { pattern: { type: "string" }, glob: { type: "string" } },
    required: ["pattern"]
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    assertGlobInsideWorkspace(context.cwd, parsed.glob);
    const regex = new RegExp(parsed.pattern);
    const files = await fg(parsed.glob, { cwd: context.cwd, dot: true, onlyFiles: true, ignore: ["node_modules/**", "dist/**", ".git/**"] });
    const rows: string[] = [];
    for (const file of files) {
      if (rows.length >= maxRows) break;
      const absolute = resolve(context.cwd, file);
      if (!isPathInsideOrSame(context.cwd, absolute)) continue;
      let text: string;
      try {
        text = await readFile(absolute, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && rows.length < maxRows; index += 1) {
        if (regex.test(lines[index]!)) rows.push(`${file}:${index + 1}:${lines[index]}`);
      }
    }
    const output = rows.join("\n");
    return { output: rows.length >= maxRows ? `${output}\n... truncated at ${maxRows} matches` : output };
  }
};
