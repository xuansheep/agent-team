import { fetch } from "undici";
import { z } from "zod";
import { Tool } from "../types.js";

const inputSchema = z.object({ url: z.string().url() });

export const webFetchTool: Tool = {
  name: "WebFetch",
  description: "Fetch text content from a URL",
  input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  async execute(input) {
    const parsed = inputSchema.parse(input);
    const response = await fetch(parsed.url);
    if (!response.ok) return { error: `HTTP ${response.status}`, exit_code: 1 };
    return { output: await response.text(), exit_code: 0 };
  }
};
