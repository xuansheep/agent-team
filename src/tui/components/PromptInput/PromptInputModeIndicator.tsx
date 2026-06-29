import React from "react";
import { Text } from "../../ink.js";
import type { PermissionMode } from "../../../permissions/PermissionMode.js";
import { PromptInputMode } from "./types.js";

export function PromptInputModeIndicator({ mode, permissionMode }: { mode: PromptInputMode; permissionMode?: PermissionMode }) {
  const label = mode === "input" ? permissionModeLabel(permissionMode ?? "default") : mode.toUpperCase();
  return <Text color={mode === "running" ? "yellow" : permissionMode === "plan" ? "magenta" : "cyan"}>{label}</Text>;
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "acceptEdits") return "ACCEPT";
  if (mode === "bypassPermissions") return "BYPASS";
  if (mode === "dontAsk") return "DONTASK";
  if (mode === "auto") return "AUTO";
  if (mode === "plan") return "PLAN";
  return "INPUT";
}
