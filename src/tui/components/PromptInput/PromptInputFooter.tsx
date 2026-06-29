import React from "react";
import { Box, Text } from "../../ink.js";
import type { PermissionMode } from "../../../permissions/PermissionMode.js";

export function PromptInputFooter({ workflowId, isLoading, permissionMode, hasSelection, columns = 80 }: { workflowId?: string; isLoading: boolean; permissionMode?: PermissionMode; hasSelection?: boolean; columns?: number }) {
  const text = `workflow ${workflowId ?? "unselected"} | mode ${permissionModeLabel(permissionMode ?? "default")} | Enter submit | Alt+Enter newline | Shift+Tab mode | Ctrl+O transcript | Esc cancel | Ctrl+C ${hasSelection ? "copy" : "stop"}${isLoading ? " | running" : ""}`;
  const lastLineWidth = text.length % Math.max(1, columns);
  const padding = lastLineWidth === 0 ? "" : " ".repeat(Math.max(0, columns - lastLineWidth));
  return (
    <Box>
      <Text dimColor>{text}{padding}</Text>
    </Box>
  );
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "acceptEdits") return "accept edits";
  if (mode === "bypassPermissions") return "bypass permissions";
  if (mode === "dontAsk") return "don't ask";
  if (mode === "auto") return "auto";
  if (mode === "plan") return "Plan Mode";
  return "default";
}
