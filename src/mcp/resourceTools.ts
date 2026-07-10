import type { Tool } from "../tools/types.js";

type ResourceRuntime = {
  listResources(input?: { server?: string }): Promise<Array<{ server: string; uri: string; name?: string; description?: string; mimeType?: string }>>;
  listResourceTemplates?(input?: { server?: string }): Promise<Array<{ server: string; uriTemplate: string; name: string; description?: string; mimeType?: string }>>;
  readResource(server: string, uri: string): Promise<unknown>;
};

export function createListMcpResourcesTool(runtime: Pick<ResourceRuntime, "listResources" | "listResourceTemplates">): Tool {
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
      const [resources, templates] = await Promise.all([runtime.listResources({ server }), runtime.listResourceTemplates?.({ server }) ?? []]);
      return {
        output: [...resources.map((resource) => `${resource.server} ${resource.uri} ${resource.name ?? ""}`), ...templates.map((template) => `${template.server} ${template.uriTemplate} ${template.name} (template)`)].join("\n"),
        data: { resources, templates }
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
      const resource = await runtime.readResource(server, uri) as { contents?: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> };
      const text = resource.contents
        ?.filter((part) => typeof part.text === "string")
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
