import type { Tool } from "../tools/types.js";

type ResourceRuntime = {
  listResources(input?: { server?: string }): Promise<Array<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }>>;
  readResource(server: string, uri: string): Promise<unknown>;
};

export function createListMcpResourcesTool(runtime: Pick<ResourceRuntime, "listResources">): Tool {
  return {
    name: "ListMcpResources",
    description: "List MCP resources by optional server.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" }
      },
      additionalProperties: false
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const server = optionalString(input, "server");
      const resources = await runtime.listResources({ server });
      return {
        output: resources.map((resource) => `${resource.server} ${resource.uri} ${resource.name ?? ""}`).join("\n"),
        data: resources
      };
    }
  };
}

export function createReadMcpResourceTool(runtime: Pick<ResourceRuntime, "readResource">): Tool {
  return {
    name: "ReadMcpResource",
    description: "Read a text MCP resource by server and uri.",
    input_schema: {
      type: "object",
      properties: {
        server: { type: "string" },
        uri: { type: "string" }
      },
      required: ["server", "uri"],
      additionalProperties: false
    },
    isReadOnly: () => true,
    async execute(input) {
      const value = requiredObject(input);
      const server = requiredString(value, "server");
      const uri = requiredString(value, "uri");
      const resource = await runtime.readResource(server, uri) as { contents?: Array<{ type?: string; text?: string; mimeType?: string }> };
      const text = resource.contents
        ?.filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n");
      if (!text) return { error: `MCP resource ${uri} did not contain readable text`, data: resource };
      return { output: text, data: resource };
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
