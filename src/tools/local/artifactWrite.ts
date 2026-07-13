import { basename } from "node:path";
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
  description: "Write a user-facing deliverable into this run's artifacts",
  input_schema: {
    type: "object",
    properties: { name: { type: "string" }, content: { type: "string" }, description: { type: "string" } },
    required: ["name", "content", "description"]
  },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (!isPlainArtifactName(parsed.name)) throw new Error(`Invalid artifact name ${parsed.name}`);
    if (!context.runDir) throw new Error("ArtifactWrite requires a run directory");
    if (!context.nodeId) throw new Error("ArtifactWrite requires a node id");

    const ref = await new ArtifactStore(context.runDir).writeText(context.nodeId, parsed.name, parsed.content, {
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

function isPlainArtifactName(name: string): boolean {
  return name === basename(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}
