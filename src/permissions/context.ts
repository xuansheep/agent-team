import { ToolContext } from "../tools/types.js";
import { PermissionMode } from "./PermissionMode.js";

export type ToolPermissionContext = {
  mode: PermissionMode;
  prePlanMode?: PermissionMode;
  allow: string[];
  ask: string[];
  deny: string[];
  transientAllow?: string[];
  source?: "workflow" | "session" | "settings";
  planFilePath?: string;
};

export type ToolPermissionCheckContext = ToolPermissionContext & Pick<ToolContext, "cwd">;

export type ToolPermissionDecision = {
  decision: "allow" | "ask" | "deny";
  rule?: string;
  reason?: string;
};
