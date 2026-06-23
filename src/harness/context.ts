import { readFile } from "node:fs/promises";
import { WorkflowNodeConfig } from "../config/schema.js";
import { ModelContentPart, ModelMessage } from "../providers/types.js";
import { nodeResultOutputInstructions } from "../team/nodeResult.js";

export type ImageHandoffItem = {
  artifact_id: string;
  path: string;
  media_type: "image/png" | "image/jpeg" | "image/webp";
};

type HandoffWithImages = {
  images?: ImageHandoffItem[];
};

export async function buildNodeMessages(node: WorkflowNodeConfig, systemPrompt: string, handoff: unknown): Promise<ModelMessage[]> {
  const protocolPrompt = `${systemPrompt}\n\n${nodeResultOutputInstructions}\n\n${nodeModeInstructions(node)}`;
  const images = collectImages(handoff);
  const userContent = JSON.stringify({ node_id: node.id, node_mode: node.mode ?? "task", handoff }, null, 2);
  if (!images.length) {
    return [
      { role: "system", content: protocolPrompt },
      { role: "user", content: userContent }
    ];
  }

  const content: ModelContentPart[] = [{ type: "text", text: userContent }];
  for (const image of images) {
    const data = await readFile(image.path, "base64");
    content.push({ type: "image", media_type: image.media_type, data });
  }
  return [
    { role: "system", content: protocolPrompt },
    { role: "user", content }
  ];
}

export function handoffHasImages(handoff: unknown): boolean {
  return collectImages(handoff).length > 0;
}

function nodeModeInstructions(node: WorkflowNodeConfig): string {
  if (node.mode === "plan") {
    return [
      "This node is a plan review checkpoint.",
      "First analyze the user's task intent, then write a concrete execution plan for downstream nodes.",
      "Return status success only when the plan is ready for user review.",
      "Put the complete Markdown plan in document."
    ].join("\n");
  }
  if (node.mode === "complete") {
    return [
      "This node is the workflow completion checkpoint.",
      "Summarize what the workflow did, key outcomes, verification, and any residual risks for the user.",
      "Put the complete Markdown summary in document."
    ].join("\n");
  }
  return "This node is a normal task node.";
}

function collectImages(handoff: unknown): ImageHandoffItem[] {
  if (!handoff || typeof handoff !== "object") return [];
  const direct = (handoff as HandoffWithImages).images;
  if (Array.isArray(direct)) return direct;
  const nested = (handoff as { previous_handoff?: unknown }).previous_handoff;
  return collectImages(nested);
}
