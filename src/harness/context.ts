import { readFile } from "node:fs/promises";
import { buildPlanModeExitAttachment, buildToolPromptsAttachment, RuntimeAttachment } from "../context/attachments.js";
import { buildRuntimeMessages } from "../context/messages.js";
import { WorkflowNodeConfig } from "../config/schema.js";
import { ModelContentPart, ModelMessage } from "../providers/types.js";
import { planModeExitHandoffMarker, planModeExitPlanExistsMarker, stripInternalPlanModeHandoffMarkers } from "../plans/planSession.js";
import { ArtifactStore, ArtifactTextChunk } from "../storage/artifacts.js";
import { nodeResultOutputInstructions } from "../team/nodeResult.js";
import { Tool } from "../tools/types.js";
import { PermissionMode } from "../permissions/PermissionMode.js";
import type { NodeNavigation } from "../workflow/nodeTransitionController.js";

export type ImageHandoffItem = {
  artifact_id: string;
  path: string;
  media_type: "image/png" | "image/jpeg" | "image/webp";
};

type HandoffWithImages = {
  images?: ImageHandoffItem[];
};

export async function buildNodeMessages(
  node: WorkflowNodeConfig,
  systemPrompt: string,
  handoff: unknown,
  input: { tools?: Tool[]; permissionMode?: PermissionMode; navigation?: NodeNavigation; runDir?: string; onArtifactRead?: (chunk: ArtifactTextChunk) => void | Promise<void> } = {}
): Promise<ModelMessage[]> {
  const protocolPrompt = `${systemPrompt}\n\n${nodeResultOutputInstructions}\n\n${nodeModeInstructions(node)}`;
  const images = collectImages(handoff);
  const referencedArtifacts = input.runDir ? await materializeReferencedArtifacts(handoff, input.runDir, input.onArtifactRead) : [];
  const userContent = JSON.stringify({
    node_id: node.id,
    node_mode: node.mode ?? "task",
    navigation: input.navigation,
    handoff: stripInternalPlanModeHandoffMarkers(handoff),
    referenced_artifacts: referencedArtifacts
  }, null, 2);
  const attachments = runtimeAttachmentsFromHandoff(handoff);
  const toolPrompts = input.tools ? buildToolPromptsAttachment({ tools: input.tools }) : undefined;
  if (toolPrompts) attachments.unshift(toolPrompts);
  if (!images.length) {
    return buildRuntimeMessages({ system: protocolPrompt, user: userContent, userMessageKind: "runtime_context", attachments });
  }

  const content: ModelContentPart[] = [{ type: "text", text: userContent }];
  for (const image of images) {
    const data = await readFile(image.path, "base64");
    content.push({ type: "image", media_type: image.media_type, data });
  }
  return buildRuntimeMessages({ system: protocolPrompt, user: content, userMessageKind: "runtime_context", attachments });
}

export function handoffHasImages(handoff: unknown): boolean {
  return collectImages(handoff).length > 0;
}

async function materializeReferencedArtifacts(
  handoff: unknown,
  runDir: string,
  onArtifactRead?: (chunk: ArtifactTextChunk) => void | Promise<void>
): Promise<ArtifactTextChunk[]> {
  const ids = artifactIdsFromHandoff(handoff);
  if (!ids.length) return [];
  const store = new ArtifactStore(runDir);
  const result: ArtifactTextChunk[] = [];
  let remaining = 256 * 1024;
  for (const artifactId of ids) {
    if (remaining <= 0) break;
    const chunk = await store.readText(artifactId, { maxBytes: Math.min(64 * 1024, remaining) });
    result.push(chunk);
    await onArtifactRead?.(chunk);
    remaining -= Buffer.byteLength(chunk.content, "utf8");
  }
  return result;
}

function artifactIdsFromHandoff(handoff: unknown): string[] {
  if (!handoff || typeof handoff !== "object") return [];
  const value = handoff as { references?: unknown; previous_handoff?: unknown };
  const ids: string[] = [];
  if (Array.isArray(value.references)) {
    for (const reference of value.references) {
      if (!reference || typeof reference !== "object") continue;
      const artifactIds = (reference as { artifact_ids?: unknown }).artifact_ids;
      if (Array.isArray(artifactIds)) {
        for (const artifactId of artifactIds) if (typeof artifactId === "string" && artifactId) ids.push(artifactId);
      }
    }
  }
  ids.push(...artifactIdsFromHandoff(value.previous_handoff));
  return [...new Set(ids)];
}

function nodeModeInstructions(node: WorkflowNodeConfig): string {
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
    "Treat referenced_artifacts as the primary source for upstream deliverables. Use ArtifactRead for truncated content and workspace Read only for actual workspace files.",
    "Use ArtifactWrite for user-facing deliverable files that should be returned to the user.",
    "If this task has no user-facing deliverable file, make summary clear and leave document empty; the runtime will create a Markdown explanation artifact."
  ].join("\n");
}

function runtimeAttachmentsFromHandoff(handoff: unknown): RuntimeAttachment[] {
  if (!handoff || typeof handoff !== "object") return [];
  const value = handoff as { approved_plan?: unknown; plan_file_path?: unknown; [planModeExitHandoffMarker]?: unknown; [planModeExitPlanExistsMarker]?: unknown };
  if (value[planModeExitHandoffMarker] !== true && (typeof value.approved_plan !== "string" || !value.approved_plan.trim())) return [];
  const planExists = value[planModeExitPlanExistsMarker] !== false;
  return [buildPlanModeExitAttachment({
    planFilePath: planExists && typeof value.plan_file_path === "string" ? value.plan_file_path : undefined
  })];
}

function collectImages(handoff: unknown): ImageHandoffItem[] {
  if (!handoff || typeof handoff !== "object") return [];
  const direct = (handoff as HandoffWithImages).images;
  if (Array.isArray(direct)) return direct;
  const nested = (handoff as { previous_handoff?: unknown }).previous_handoff;
  return collectImages(nested);
}
