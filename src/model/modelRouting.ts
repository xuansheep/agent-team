import type { PermissionMode } from "../permissions/PermissionMode.js";
import { ModelRegistry, resolveModelAlias } from "./modelRegistry.js";

export type ModelRoutingInput = {
  node?: { model?: string };
  role?: { default_model?: string };
  provider: { default_model: string };
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
