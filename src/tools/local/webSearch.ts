import { Tool } from "../types.js";

export const webSearchTool: Tool = {
  name: "WebSearch",
  description: "Search the web when a search provider is configured",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  async execute() {
    return { error: "WebSearch is unsupported until a search provider is configured", exit_code: 1 };
  }
};
