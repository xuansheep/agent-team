import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
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

    const dir = join(context.runDir, "artifacts", context.nodeId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, parsed.name);
    await writeFile(path, parsed.content, "utf8");

    return {
      output: `Wrote ${path}`,
      artifact_id: `${context.nodeId}/${parsed.name}`,
      path,
      description: parsed.description
    };
  }
};

function isPlainArtifactName(name: string): boolean {
  return name === basename(name) && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\\");
}
