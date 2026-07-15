import type { PermissionMode } from "../permissions/PermissionMode.js";
import { ModelRegistry, resolveModelAlias } from "./modelRegistry.js";

export type ModelRoutingInput = {
  node?: { model?: string; effort?: string };
  role?: { default_model?: string };
  provider: { default_model: string; effort?: string };
  permissionMode?: PermissionMode;
  planModel?: string;
  registry?: ModelRegistry;
};

export function resolveModelForWorkflowNode(input: ModelRoutingInput): string {
  const selected = input.permissionMode === "plan" && input.planModel
    ? input.planModel
    : input.node?.model ?? input.role?.default_model ?? input.provider.default_model;
  return resolveModelAlias(selected, input.registry);
}

export function resolveEffortForWorkflowNode(input: Pick<ModelRoutingInput, "node" | "provider">): string {
  return input.node?.effort ?? input.provider.effort ?? "medium";
}
