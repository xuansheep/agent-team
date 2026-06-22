import { readFile } from "node:fs/promises";
import { WorkflowNodeConfig } from "../config/schema.js";
import { ModelContentPart, ModelMessage } from "../providers/types.js";

export type ImageHandoffItem = {
  artifact_id: string;
  path: string;
  media_type: "image/png" | "image/jpeg" | "image/webp";
};

type HandoffWithImages = {
  images?: ImageHandoffItem[];
};

export async function buildNodeMessages(node: WorkflowNodeConfig, systemPrompt: string, handoff: unknown): Promise<ModelMessage[]> {
  const images = collectImages(handoff);
  const userContent = JSON.stringify({ node_id: node.id, handoff }, null, 2);
  if (!images.length) {
    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent }
    ];
  }

  const content: ModelContentPart[] = [{ type: "text", text: userContent }];
  for (const image of images) {
    const data = await readFile(image.path, "base64");
    content.push({ type: "image", media_type: image.media_type, data });
  }
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content }
  ];
}

export function handoffHasImages(handoff: unknown): boolean {
  return collectImages(handoff).length > 0;
}

function collectImages(handoff: unknown): ImageHandoffItem[] {
  if (!handoff || typeof handoff !== "object") return [];
  const direct = (handoff as HandoffWithImages).images;
  if (Array.isArray(direct)) return direct;
  const nested = (handoff as { previous_handoff?: unknown }).previous_handoff;
  return collectImages(nested);
}
