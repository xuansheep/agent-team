import { readFile } from "node:fs/promises";
import { buildPlanModeExitAttachment, RuntimeAttachment } from "../context/attachments.js";
import { buildRuntimeMessages } from "../context/messages.js";
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
  const attachments = runtimeAttachmentsFromHandoff(handoff);
  if (!images.length) {
    return buildRuntimeMessages({ system: protocolPrompt, user: userContent, attachments });
  }

  const content: ModelContentPart[] = [{ type: "text", text: userContent }];
  for (const image of images) {
    const data = await readFile(image.path, "base64");
    content.push({ type: "image", media_type: image.media_type, data });
  }
  return buildRuntimeMessages({ system: protocolPrompt, user: content, attachments });
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
      "Put the complete Markdown plan in document.",
      "Do not put the primary review plan only in ArtifactWrite; ArtifactWrite may only contain supporting material."
    ].join("\n");
  }
  if (node.mode === "complete") {
    return [
      "This node is the workflow completion checkpoint.",
      "Summarize what the workflow did, key outcomes, verification, and any residual risks for the user.",
      "Put the complete Markdown summary in document.",
      "The runtime will store the summary as this node's final deliverable artifact if no deliverable file exists."
    ].join("\n");
  }
  return [
    "This node is a normal task node.",
    "Use ArtifactWrite for user-facing deliverable files that should be returned to the user.",
    "If this task has no user-facing deliverable file, make summary clear and leave document empty; the runtime will create a Markdown explanation artifact."
  ].join("\n");
}

function runtimeAttachmentsFromHandoff(handoff: unknown): RuntimeAttachment[] {
  if (!handoff || typeof handoff !== "object") return [];
  const value = handoff as { approved_plan?: unknown; original_input?: unknown };
  if (typeof value.approved_plan !== "string" || !value.approved_plan.trim()) return [];
  return [buildPlanModeExitAttachment({ approvedPlan: value.approved_plan, originalInput: value.original_input })];
}

function collectImages(handoff: unknown): ImageHandoffItem[] {
  if (!handoff || typeof handoff !== "object") return [];
  const direct = (handoff as HandoffWithImages).images;
  if (Array.isArray(direct)) return direct;
  const nested = (handoff as { previous_handoff?: unknown }).previous_handoff;
  return collectImages(nested);
}
