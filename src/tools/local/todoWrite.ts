import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Tool } from "../types.js";

const todoSchema = z.object({ content: z.string(), status: z.enum(["pending", "in_progress", "completed"]) });
const inputSchema = z.object({ todos: z.array(todoSchema) });

export const todoWriteTool: Tool = {
  name: "TodoWrite",
  description: "Store a node-local todo list",
  input_schema: { type: "object", properties: { todos: { type: "array" } }, required: ["todos"] },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    const output = JSON.stringify(parsed.todos, null, 2);
    if (context.planState?.mode === "planning" || context.planState?.mode === "waiting_approval") {
      return { output };
    }
    if (!context.runDir) return { output };
    const dir = join(context.runDir, "artifacts", "todos");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "todos.json");
    await writeFile(path, `${output}\n`, "utf8");
    return { output: `Wrote ${path}`, artifact_id: "todos/todos.json" };
  }
};
