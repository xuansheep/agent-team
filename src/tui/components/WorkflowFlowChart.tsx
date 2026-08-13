import type { BorderStyle } from "../../ink/render-border.js";
import { contextUsedPercent } from "../../model/contextUsage.js";
import { getModelContextLimits } from "../../model/modelRegistry.js";
import { useAnimationFrame } from "../../ink/hooks/use-animation-frame.js";
import { stringWidth } from "../../ink/stringWidth.js";
import { Box, Text } from "../ink.js";
import { TuiNodeState, TuiWorkflowNodeState } from "../state.js";
import { formatTokenCount } from "./StatusLine.js";

const RUNNING_TOP_RIGHT_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const RUNNING_TOP_RIGHT_INTERVAL_MS = 80;

const NODE_BORDER = {
  top: "─",
  bottom: "─",
  left: "│",
  right: "│",
  topLeft: "┌",
  topRight: "┐",
  bottomRight: "┘",
  bottomLeft: "└"
};

export function WorkflowFlowChart({
  nodes,
  workflowNodes,
  busNodeId,
  columns,
  currentNodeId,
  suspendedStack = [],
  showConnectors = true,
  showBusRow = true
}: {
  nodes: TuiNodeState[];
  workflowNodes?: TuiWorkflowNodeState[];
  busNodeId?: string;
  columns?: number;
  currentNodeId?: string;
  suspendedStack?: string[];
  showConnectors?: boolean;
  showBusRow?: boolean;
}) {
  const [animationRef, animationTime] = useAnimationFrame(nodes.some((node) => node.status === "running") ? RUNNING_TOP_RIGHT_INTERVAL_MS : null);
  const runningBorder: BorderStyle = { ...NODE_BORDER, topRight: RUNNING_TOP_RIGHT_FRAMES[Math.floor(animationTime / RUNNING_TOP_RIGHT_INTERVAL_MS) % RUNNING_TOP_RIGHT_FRAMES.length] };
  const rows = workflowNodes?.length
    ? workflowNodes.map((node) => ({ id: node.id, model: node.model, effort: node.effort, contextWindow: node.contextWindow, state: latestNodeState(nodes, node.id) }))
    : nodes.map((node) => {
      const limits = getModelContextLimits(node.model ?? "");
      return {
        id: node.nodeId,
        model: node.model,
        effort: undefined,
        contextWindow: node.contextWindow ?? limits.effectiveContextWindow,
        state: node
      };
    });
  const displayRows = rows.map((row) => {
    const active = row.id === currentNodeId;
    const running = row.state?.status === "running";
    const color = nodeColor(row.state, active);
    const contextTokens = Math.max(0, row.state?.contextTokens ?? 0);
    const limits = getModelContextLimits(row.model ?? "");
    const contextWindow = row.state?.contextWindow ?? row.contextWindow ?? limits.effectiveContextWindow;
    const contextPercent = contextUsedPercent(contextTokens, contextWindow);
    const contextText = `context: ${formatTokenCount(contextTokens).toLowerCase()}/${formatTokenCount(contextWindow).toLowerCase()} (${contextPercent}%)`;
    const modelText = row.model ? `model: ${row.model}${row.effort ? " " + row.effort : ""}` : undefined;
    const statusText = statusLabel(row.state);
    const contentWidth = Math.max(
      stringWidth(row.id),
      stringWidth(contextText),
      stringWidth(statusText),
      modelText ? stringWidth(modelText) : 0
    );
    return {
      ...row,
      active,
      running,
      color,
      contextText,
      modelText,
      statusText,
      cardWidth: Math.max(18, contentWidth + 4)
    };
  });
  const busNodeIndex = busNodeId ? displayRows.findIndex((row) => row.id === busNodeId) : -1;
  const showBus = showBusRow && displayRows.length > 0;
  const availableColumns = columns && columns > 0 ? columns : Number.POSITIVE_INFINITY;
  let layoutRow = 0;
  let layoutRowWidth = 0;
  const cellLayouts = displayRows.map((row, index) => {
    const connectorWidth = showConnectors && index < displayRows.length - 1 ? stringWidth(" -> ") : 0;
    const cellWidth = row.cardWidth + connectorWidth;
    if (layoutRowWidth > 0 && layoutRowWidth + cellWidth > availableColumns) {
      layoutRow += 1;
      layoutRowWidth = 0;
    }
    const cell = { cellWidth, row: layoutRow };
    layoutRowWidth += cellWidth;
    return cell;
  });
  const busLayoutRow = busNodeIndex >= 0 ? cellLayouts[busNodeIndex]?.row ?? -1 : -1;
  const nodeCells = displayRows.map((row, index) => {
    const cellLayout = cellLayouts[index]!;
    const connectorText = showConnectors && index < displayRows.length - 1 ? " -> " : "";
    const cellWidth = cellLayout.cellWidth;
    const branchColumn = Math.floor(row.cardWidth / 2);
    const busLineVisible = showBus && (busNodeIndex < 0 || cellLayout.row <= busLayoutRow);
    let busSegment = index === 0 && busNodeIndex < 0 ? "bus" + " ".repeat(Math.max(0, cellWidth - 3)) : " ".repeat(cellWidth);
    if (busLineVisible && index < busNodeIndex) {
      busSegment = index === 0
        ? `bus ${"─".repeat(Math.max(0, cellWidth - 4))}`
        : "─".repeat(cellWidth);
    } else if (busLineVisible && index === busNodeIndex) {
      const line = index === 0
        ? `bus ${"─".repeat(Math.max(0, branchColumn - 4))}`
        : "─".repeat(branchColumn);
      busSegment = `${line}┐${" ".repeat(Math.max(0, cellWidth - branchColumn - 1))}`;
    }
    const card = (
      <Box borderStyle={row.running ? runningBorder : "single"} borderColor={row.color} width={showBus ? row.cardWidth : undefined} minWidth={showBus ? undefined : 18} paddingX={1} flexDirection="column">
        <Text color={row.color} bold={row.active} dimColor={!row.state}>{row.id}</Text>
        {row.modelText ? <Text color={row.color} dimColor={!row.state}>{row.modelText}</Text> : null}
        <Text color={row.color} dimColor={!row.state}>{row.contextText}</Text>
        <Text color={row.color} dimColor={!row.state}>{row.statusText}</Text>
      </Box>
    );
    if (!showBus) {
      return (
        <Box key={row.id} alignItems="center">
          {card}
          {connectorText ? <Text dimColor>{connectorText}</Text> : null}
        </Box>
      );
    }
    return (
      <Box key={row.id} flexDirection="column" width={cellWidth} flexShrink={0}>
        {busLineVisible ? <Text dimColor>{busSegment}</Text> : null}
        <Box alignItems="center">
          {card}
          {connectorText ? <Text dimColor>{connectorText}</Text> : null}
        </Box>
      </Box>
    );
  });

  return (
    <Box ref={animationRef} flexDirection={showBus ? "column" : "row"} flexWrap={showBus ? "nowrap" : "wrap"} flexShrink={0}>
      {showBus ? <Box flexWrap="wrap" flexShrink={0}>{nodeCells}</Box> : nodeCells}
      {suspendedStack.length ? <Box width="100%"><Text color="yellow">挂起链：{suspendedStack.join(" → ")}</Text></Box> : null}
    </Box>
  );
}

function latestNodeState(nodes: TuiNodeState[], nodeId: string): TuiNodeState | undefined {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (node.nodeId === nodeId) return node;
  }
  return undefined;
}

function statusLabel(node: TuiNodeState | undefined): string {
  if (!node) return "pending";
  const ref = `#${node.attempt}.${node.activation ?? 1}`;
  if (node.status === "running") return `running ${ref}`;
  if (node.status === "completed" || node.status === "success") return `done ${ref}`;
  if (node.status === "suspended") return `suspended ${ref}`;
  if (node.status === "failure") return `failed ${ref}`;
  if (node.status === "waiting_user") return `waiting user ${ref}`;
  return `interrupted ${ref}`;
}

function nodeColor(node: TuiNodeState | undefined, active: boolean): "cyan" | "green" | "red" | "yellow" | undefined {
  if (active) return "cyan";
  if (!node) return undefined;
  if (node.status === "completed" || node.status === "success") return "green";
  if (node.status === "failure" || node.status === "interrupted") return "red";
  if (node.status === "waiting_user" || node.status === "suspended") return "yellow";
  return undefined;
}
