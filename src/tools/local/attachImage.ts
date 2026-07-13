import { basename } from "node:path";
import { z } from "zod";
import { ArtifactStore } from "../../storage/artifacts.js";
import { Tool } from "../types.js";
import { resolveWorkspacePath } from "./path.js";

const inputSchema = z.object({ path: z.string().min(1), artifact_id: z.string().optional() });

export const attachImageTool: Tool = {
  name: "AttachImage",
  description: "Attach a local image path or image artifact to the model context",
  input_schema: { type: "object", properties: { path: { type: "string" }, artifact_id: { type: "string" } }, required: ["path"] },
  async execute(input, context) {
    const parsed = inputSchema.parse(input);
    if (!context.runDir || !context.nodeId) throw new Error("AttachImage requires an active workflow run");
    const path = resolveWorkspacePath(context.cwd, parsed.path);
    const ref = await new ArtifactStore(context.runDir).importFile(context.nodeId, path, basename(path), {
      description: "节点附加图片",
      attempt: context.attempt,
      activation: context.activation
    });
    return { output: `Attached image ${parsed.path}`, artifact_id: ref.artifactId, path: ref.path, description: "节点附加图片" };
  }
};
