import { readFile } from "node:fs/promises";
import { buildPlanModeExitAttachment, buildToolPromptsAttachment, RuntimeAttachment } from "../context/attachments.js";
import { buildRuntimeMessages } from "../context/messages.js";
import type { ExecutionKind, WorkflowNodeConfig } from "../config/schema.js";
import { ModelContentPart, ModelMessage } from "../providers/types.js";
import { planModeExitHandoffMarker, planModeExitPlanExistsMarker, stripInternalPlanModeHandoffMarkers } from "../plans/planSession.js";
import { ArtifactContent, ArtifactStore, ArtifactTextChunk } from "../storage/artifacts.js";
import { nodeResultOutputInstructions } from "../team/nodeResult.js";
import { Tool } from "../tools/types.js";
import { PermissionMode } from "../permissions/PermissionMode.js";
import type { NodeNavigation } from "../workflow/nodeTransitionController.js";
import { compactHandoffForModel } from "../team/handoff.js";

export type ImageHandoffItem = {
  artifact_id: string;
  path: string;
  media_type: "image/png" | "image/jpeg" | "image/webp";
};

type HandoffWithImages = {
  images?: ImageHandoffItem[];
};

type ReferencedArtifact =
  | (ArtifactTextChunk & { kind: "text" })
  | {
      artifact_id: string;
      logical_name: string;
      description: string;
      sha256: string;
      kind: "image" | "binary";
      media_type?: "image/png" | "image/jpeg" | "image/webp";
      total_bytes: number;
      content_note: string;
    };

type MaterializedArtifacts = {
  referencedArtifacts: ReferencedArtifact[];
  imageParts: ModelContentPart[];
};

export async function buildNodeMessages(
  node: WorkflowNodeConfig,
  systemPrompt: string,
  handoff: unknown,
  input: {
    tools?: Tool[];
    permissionMode?: PermissionMode;
    navigation?: NodeNavigation;
    executionKind?: ExecutionKind;
    runDir?: string;
    supportsVision?: boolean;
    onArtifactRead?: (chunk: ArtifactTextChunk) => void | Promise<void>;
  } = {}
): Promise<ModelMessage[]> {
  const taskInstructions = input.executionKind === "team" ? teamNodeTaskInstructions : nodeTaskInstructions;
  const protocolPrompt = `${systemPrompt}\n\n${nodeResultOutputInstructions}\n\n${taskInstructions}`;
  const modelHandoff = compactHandoffForModel(handoff);
  const materialized = input.runDir
    ? await materializeReferencedArtifacts(modelHandoff, input.runDir, input.supportsVision ?? false, input.onArtifactRead)
    : { referencedArtifacts: [], imageParts: [] };
  const userContent = JSON.stringify({
    node_id: node.id,
    execution_kind: input.executionKind ?? "workflow",
    navigation: input.navigation,
    handoff: stripInternalPlanModeHandoffMarkers(modelHandoff),
    referenced_artifacts: materialized.referencedArtifacts
  }, null, 2);
  const attachments = runtimeAttachmentsFromHandoff(modelHandoff);
  const toolPrompts = input.tools ? buildToolPromptsAttachment({ tools: input.tools }) : undefined;
  if (toolPrompts) attachments.unshift(toolPrompts);

  const directImages = collectImages(modelHandoff);
  if (!directImages.length && !materialized.imageParts.length) {
    return buildRuntimeMessages({ system: protocolPrompt, user: userContent, userMessageKind: "runtime_context", attachments });
  }

  const content: ModelContentPart[] = [{ type: "text", text: userContent }, ...materialized.imageParts];
  for (const image of directImages) {
    const data = await readFile(image.path, "base64");
    content.push({ type: "image", media_type: image.media_type, data });
  }
  return buildRuntimeMessages({ system: protocolPrompt, user: content, userMessageKind: "runtime_context", attachments });
}

export function handoffHasImages(handoff: unknown): boolean {
  return collectImages(compactHandoffForModel(handoff)).length > 0;
}

async function materializeReferencedArtifacts(
  handoff: unknown,
  runDir: string,
  supportsVision: boolean,
  onArtifactRead?: (chunk: ArtifactTextChunk) => void | Promise<void>
): Promise<MaterializedArtifacts> {
  const ids = artifactIdsFromHandoff(handoff);
  const referencedArtifacts: ReferencedArtifact[] = [];
  const imageParts: ModelContentPart[] = [];
  if (!ids.length) return { referencedArtifacts, imageParts };

  const store = new ArtifactStore(runDir);
  let remaining = 256 * 1024;
  for (const artifactId of ids) {
    if (remaining <= 0) break;
    const artifact = await store.read(artifactId);
    if (artifact.kind === "text") {
      const chunk = await store.readText(artifactId, { maxBytes: Math.min(64 * 1024, remaining) });
      referencedArtifacts.push({ ...chunk, kind: "text" });
      await onArtifactRead?.(chunk);
      remaining -= Buffer.byteLength(chunk.content, "utf8");
      continue;
    }

    const descriptor = artifactDescriptor(artifact);
    if (artifact.kind === "image" && artifact.mediaType) {
      referencedArtifacts.push({
        ...descriptor,
        kind: "image",
        media_type: artifact.mediaType,
        content_note: supportsVision
          ? "Image content is attached to this model message."
          : "Image content was omitted because this provider does not support vision."
      });
      if (supportsVision) {
        imageParts.push({ type: "image", media_type: artifact.mediaType, data: artifact.bytes.toString("base64") });
      }
      continue;
    }

    referencedArtifacts.push({
      ...descriptor,
      kind: "binary",
      content_note: "Binary content is not injected into model context."
    });
  }
  return { referencedArtifacts, imageParts };
}

function artifactDescriptor(artifact: ArtifactContent) {
  return {
    artifact_id: artifact.record.artifact_id,
    logical_name: artifact.record.logical_name,
    description: artifact.record.description,
    sha256: artifact.record.sha256,
    total_bytes: artifact.bytes.length
  };
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

const commonNodeTaskInstructions = [
  "Treat the top-level handoff and latest user_input as the authoritative current requirements. They override conflicting previous_handoff content or older referenced artifacts.",
  "Treat referenced_artifacts as evidence for upstream deliverables, ordered with current handoff references first. Use ArtifactRead for truncated text content; image and binary artifacts may be represented by metadata only.",
  "Use ArtifactWrite for user-facing deliverable files that should be returned to the user.",
  "If this task has no user-facing deliverable file, make summary clear and leave document empty; the runtime will create a Markdown explanation artifact."
];

const teamNodeTaskInstructions = [
  "This is a dynamically routed team member. The bus exclusively owns every next-node and completion decision.",
  "Complete only the assigned member task, then submit NodeResult and return control to the bus.",
  "NodeResult.direction is advisory evidence only in team mode; it must never directly dispatch, retry, or select another member.",
  "Put concrete rework needs in feedback and handoff. Put missing user decisions in questions or handoff so the bus can clarify.",
  "The bus receives the full dossier after this member finishes and may dispatch any team member or finalize the task.",
  ...commonNodeTaskInstructions
].join("\n");

const nodeTaskInstructions = [
  "This is a workflow task node. The workflow bus owns task completion and all final user-facing summaries.",
  ...commonNodeTaskInstructions
].join("\n");

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
