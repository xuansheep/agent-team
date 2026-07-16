import { z } from "zod";
import { ArtifactStore } from "../../storage/artifacts.js";
import { Tool } from "../types.js";

const inputSchema = z.object({
  name: z.string().min(1),
  content: z.string(),
  description: z.string().default("")
});

export const artifactWriteTool: Tool = {
  name: "ArtifactWrite",
  description: "Write a user-facing deliverable into this run's artifacts. Use a basename or the current node prefix, for example design.md or ui/design.md.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string" }, content: { type: "string" }, description: { type: "string" } },
    required: ["name", "content", "description"]
  },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (!context.runDir) throw new Error("ArtifactWrite requires a run directory");
    if (!context.nodeId) throw new Error("ArtifactWrite requires a node id");
    const name = normalizeArtifactName(parsed.name, context.nodeId);

    const ref = await new ArtifactStore(context.runDir).writeText(context.nodeId, name, parsed.content, {
      description: parsed.description,
      attempt: context.attempt,
      activation: context.activation
    });

    return {
      output: `Wrote immutable artifact ${ref.artifactId}`,
      artifact_id: ref.artifactId,
      path: ref.path,
      description: parsed.description
    };
  }
};

function normalizeArtifactName(name: string, nodeId: string): string {
  const normalized = name.replaceAll("\\", "/");
  const segments = normalized.split("/");
  const value = segments.length === 1
    ? segments[0]
    : segments.length === 2 && segments[0] === nodeId ? segments[1] : undefined;
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
    throw new Error(`Invalid artifact name ${name}`);
  }
  return value;
}
