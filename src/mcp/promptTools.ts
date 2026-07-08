import type { Tool } from "../tools/types.js";

type PromptRuntime = {
  listPrompts(input?: { server?: string }): Promise<Array<{ server: string; name: string; description?: string; arguments?: unknown[] }>>;
  getPrompt(server: string, name: string, args: Record<string, unknown>): Promise<unknown>;
};

export function createListMcpPromptsTool(runtime: Pick<PromptRuntime, "listPrompts">): Tool {
  return {
    name: "ListMcpPrompts",
    description: "List MCP prompts by optional server.",
    input_schema: {
      type: "object",
      properties: { server: { type: "string" } },
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const prompts = await runtime.listPrompts({ server: optionalString(input, "server") });
      return {
        output: prompts.map((prompt) => `${prompt.server} ${prompt.name}: ${prompt.description ?? ""}`).join("\n"),
        data: prompts
      };
    }
  };
}

export function createGetMcpPromptTool(runtime: Pick<PromptRuntime, "listPrompts">): Tool {
  return {
    name: "GetMcpPrompt",
    description: "Get MCP prompt metadata.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        name: { type: "string" }
      },
      required: ["server", "name"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input) {
      const value = requiredObject(input);
      const server = requiredString(value, "server");
      const name = requiredString(value, "name");
      const prompt = (await runtime.listPrompts({ server })).find((item) => item.name === name);
      if (!prompt) return { error: `Unknown MCP prompt ${server}/${name}` };
      return { output: JSON.stringify(prompt), data: prompt };
    }
  };
}

export function createRunMcpPromptTool(runtime: Pick<PromptRuntime, "getPrompt">): Tool {
  return {
    name: "RunMcpPrompt",
    description: "Run an MCP prompt by server, name, and arguments.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        name: { type: "string" },
        arguments: { type: "object", additionalProperties: true }
      },
      required: ["server", "name"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input) {
      const value = requiredObject(input);
      const server = requiredString(value, "server");
      const name = requiredString(value, "name");
      const args = value.arguments && typeof value.arguments === "object" && !Array.isArray(value.arguments)
        ? value.arguments as Record<string, unknown>
        : {};
      const prompt = await runtime.getPrompt(server, name, args);
      return { output: JSON.stringify(prompt), data: prompt };
    }
  };
}

function optionalString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function requiredObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Input must be an object");
  return input as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required`);
  return value;
}
