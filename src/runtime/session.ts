import { ModelMessage } from "../providers/types.js";
import { ToolPermissionContext } from "./types.js";

export type RuntimeSession = {
  sessionId: string;
  messages: ModelMessage[];
  permissions: ToolPermissionContext;
};

export function createRuntimeSession(input: {
  sessionId: string;
  messages?: ModelMessage[];
  permissions?: Partial<ToolPermissionContext>;
}): RuntimeSession {
  return {
    sessionId: input.sessionId,
    messages: input.messages ?? [],
    permissions: {
      mode: input.permissions?.mode ?? "default",
      prePlanMode: input.permissions?.prePlanMode,
      allow: input.permissions?.allow ?? [],
      ask: input.permissions?.ask ?? [],
      deny: input.permissions?.deny ?? [],
      source: input.permissions?.source,
      planFilePath: input.permissions?.planFilePath
    }
  };
}
