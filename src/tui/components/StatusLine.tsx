import type { PermissionMode } from "../../permissions/PermissionMode.js";
import type { TuiMode } from "../state.js";
import { Box, Text } from "../ink.js";

export type StatusLineElement = "mode" | "permission" | "workflow" | "run" | "selection" | "loading";

export const defaultStatusLineElements: StatusLineElement[] = ["mode", "workflow", "run", "selection"];
export const availableStatusLineElements: StatusLineElement[] = ["mode", "permission", "workflow", "run", "selection", "loading"];

export function StatusLine({
  mode,
  permissionMode,
  workflowId,
  runId,
  isLoading,
  hasSelection,
  elements,
  columns = 80
}: {
  mode: TuiMode;
  permissionMode: PermissionMode;
  workflowId?: string;
  runId?: string;
  isLoading: boolean;
  hasSelection: boolean;
  elements: StatusLineElement[];
  columns?: number;
}) {
  const text = statusLineText({ mode, permissionMode, workflowId, runId, isLoading, hasSelection, elements });
  if (!text) return null;
  const remainder = text.length % Math.max(1, columns);
  const padding = remainder === 0 ? "" : " ".repeat(Math.max(0, columns - remainder));
  return (
    <Box flexShrink={0}>
      <Text dimColor>{text}{padding}</Text>
    </Box>
  );
}

export function statusLineText(input: {
  mode: TuiMode;
  permissionMode: PermissionMode;
  workflowId?: string;
  runId?: string;
  isLoading: boolean;
  hasSelection: boolean;
  elements: StatusLineElement[];
}): string {
  return input.elements.flatMap((element) => statusLinePart(element, input)).filter(Boolean).join(" | ");
}

function statusLinePart(element: StatusLineElement, input: {
  mode: TuiMode;
  permissionMode: PermissionMode;
  workflowId?: string;
  runId?: string;
  isLoading: boolean;
  hasSelection: boolean;
}): string[] {
  if (element === "mode") return [`mode ${effectiveModeLabel(input.mode, input.permissionMode)}`];
  if (element === "permission") return [`permission ${permissionModeLabel(input.permissionMode)}`];
  if (element === "workflow") return [`workflow ${input.workflowId ?? "unselected"}`];
  if (element === "run") return input.runId ? [`run ${input.runId}`] : [];
  if (element === "selection") return input.hasSelection ? ["selection active"] : [];
  if (element === "loading") return input.isLoading ? ["running"] : [];
  return [];
}

function effectiveModeLabel(mode: TuiMode, permissionMode: PermissionMode): string {
  if (mode === "waiting_plan_approval") return "Plan Review";
  if (mode === "planning" || (mode === "input" && permissionMode === "plan")) return "Plan";
  if (mode === "input" && permissionMode === "acceptEdits") return "Edit";
  if (mode === "input" && permissionMode === "bypassPermissions") return "Bypass";
  if (mode === "input" && permissionMode === "auto") return "Auto";
  if (mode === "input" && permissionMode === "dontAsk") return "Don't Ask";
  if (mode === "input") return "Input";
  return mode.replaceAll("_", " ");
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "acceptEdits") return "Accept Edits";
  if (mode === "bypassPermissions") return "Bypass Permissions";
  if (mode === "dontAsk") return "Don't Ask";
  if (mode === "auto") return "Auto";
  if (mode === "plan") return "Plan";
  return "Default";
}
