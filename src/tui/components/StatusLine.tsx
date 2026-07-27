import type { ModelUsageTotals } from "../../model/usage.js";
import type { PermissionMode } from "../../permissions/PermissionMode.js";
import type { TuiMode, TuiRunState } from "../state.js";
import { Box, Text } from "../ink.js";

import { defaultStatusLineElements, statusLineElementIds } from "../../settings/types.js";
import type { StatusLineElement } from "../../settings/types.js";

export { defaultStatusLineElements };
export type { StatusLineElement };

export const availableStatusLineElements: StatusLineElement[] = [...statusLineElementIds];

export function StatusLine({
  cwd,
  gitBranch,
  mode,
  runState,
  permissionMode,
  workflowId,
  runId,
  copiedSelectionChars,
  sessionUsage,
  modelRequestCount,
  elements,
  columns = 80
}: {
  cwd: string;
  gitBranch?: string;
  mode: TuiMode;
  runState: TuiRunState;
  permissionMode: PermissionMode;
  workflowId?: string;
  runId?: string;
  copiedSelectionChars?: number;
  sessionUsage: ModelUsageTotals;
  modelRequestCount: number;
  elements: StatusLineElement[];
  columns?: number;
}) {
  const text = statusLineText({ cwd, gitBranch, mode, runState, permissionMode, workflowId, runId, copiedSelectionChars, sessionUsage, modelRequestCount, elements });
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
  cwd: string;
  gitBranch?: string;
  mode: TuiMode;
  runState: TuiRunState;
  permissionMode: PermissionMode;
  workflowId?: string;
  runId?: string;
  copiedSelectionChars?: number;
  sessionUsage: ModelUsageTotals;
  modelRequestCount: number;
  elements: StatusLineElement[];
}): string {
  return input.elements.flatMap((element) => statusLinePart(element, input)).filter(Boolean).join(" | ");
}

function statusLinePart(element: StatusLineElement, input: {
  cwd: string;
  gitBranch?: string;
  mode: TuiMode;
  runState: TuiRunState;
  permissionMode: PermissionMode;
  workflowId?: string;
  runId?: string;
  copiedSelectionChars?: number;
  sessionUsage: ModelUsageTotals;
  modelRequestCount: number;
}): string[] {
  if (element === "run-state") return [runStateLabel(effectiveRunState(input.runState, input.mode))];
  if (element === "permission") return [permissionModeLabel(input.permissionMode)];
  if (element === "current-dir") return [input.cwd];
  if (element === "git-branch") return input.gitBranch ? [input.gitBranch] : [];
  if (element === "workflow") return [input.workflowId ?? "unselected"];
  if (element === "run-id") return input.runId ? [input.runId] : [];
  if (element === "tokens-io") return [`tokens ${formatTokenCount(input.sessionUsage.inputTokens)}/${formatTokenCount(input.sessionUsage.outputTokens)}`];
  if (element === "tokens-cache") {
    const inputTokens = Math.max(0, input.sessionUsage.inputTokens);
    const cachedInputTokens = Math.max(0, input.sessionUsage.cachedInputTokens);
    const hitRate = inputTokens === 0 ? 0 : Math.min(100, Math.round((cachedInputTokens / inputTokens) * 100));
    return [`cache ${formatTokenCount(cachedInputTokens)} (${hitRate}%)`];
  }
  if (element === "requests") return [`requests ${input.modelRequestCount.toLocaleString("en-US")}`];
  if (element === "selection" && input.copiedSelectionChars !== undefined) {
    return [`copied ${input.copiedSelectionChars.toLocaleString("en-US")} chars`];
  }
  return [];
}

export function formatTokenCount(tokens: number): string {
  const value = Math.max(0, Math.trunc(tokens));
  if (value < 1_000) return String(value);
  const units = [
    { threshold: 1_000_000_000, suffix: "B" },
    { threshold: 1_000_000, suffix: "M" },
    { threshold: 1_000, suffix: "K" }
  ];
  const unit = units.find((candidate) => value >= candidate.threshold)!;
  return `${(value / unit.threshold).toFixed(1).replace(/\.0$/, "")}${unit.suffix}`;
}

function effectiveRunState(runState: TuiRunState, mode: TuiMode): TuiRunState {
  if (mode === "permission" || mode === "question" || mode === "waiting_plan_approval" || mode === "paused" || mode === "confirm_interrupt" || mode === "confirm_new" || mode === "confirm_resume") return "waiting";
  return runState;
}

function runStateLabel(runState: TuiRunState): string {
  return runState[0]!.toUpperCase() + runState.slice(1);
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "fullAccess") return "full access";
  if (mode === "plan") return "plan";
  return "default";
}
