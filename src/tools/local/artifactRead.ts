import { z } from "zod";
import { ArtifactStore } from "../../storage/artifacts.js";
import { Tool } from "../types.js";

const inputSchema = z.object({
  artifact_id: z.string().min(1),
  offset: z.number().int().nonnegative().default(0),
  max_bytes: z.number().int().positive().max(128 * 1024).default(64 * 1024)
});

export const artifactReadTool: Tool = {
  name: "ArtifactRead",
  description: "Read an immutable text artifact from the current workflow run by artifact_id",
  input_schema: {
    type: "object",
    properties: {
      artifact_id: { type: "string" },
      offset: { type: "number", minimum: 0 },
      max_bytes: { type: "number", minimum: 1, maximum: 131072 }
    },
    required: ["artifact_id"]
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (!context.runDir) throw new Error("ArtifactRead requires a run directory");
    const chunk = await new ArtifactStore(context.runDir).readText(parsed.artifact_id, {
      offset: parsed.offset,
      maxBytes: parsed.max_bytes
    });
    await context.auditSink?.({
      type: "artifact_read",
      artifact_id: chunk.artifact_id,
      offset: chunk.offset,
      bytes_read: Buffer.byteLength(chunk.content, "utf8"),
      total_bytes: chunk.total_bytes,
      truncated: chunk.truncated,
      source: "tool"
    });
    return {
      output: chunk.content,
      description: chunk.description,
      data: chunk
    };
  }
};
