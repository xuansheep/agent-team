import { readFile } from "node:fs/promises";
import fg from "fast-glob";
import { z } from "zod";
import { join } from "node:path";
import { Tool } from "../types.js";

const inputSchema = z.object({ pattern: z.string().min(1), glob: z.string().default("**/*") });

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
    const regex = new RegExp(parsed.pattern);
    const files = await fg(parsed.glob, { cwd: context.cwd, dot: true, onlyFiles: true, ignore: ["node_modules/**", "dist/**", ".git/**"] });
    const rows: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = await readFile(join(context.cwd, file), "utf8");
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        if (regex.test(line)) rows.push(`${file}:${index + 1}:${line}`);
      });
    }
    return { output: rows.join("\n") };
  }
};
