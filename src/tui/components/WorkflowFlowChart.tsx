import type { BorderStyle } from "../../ink/render-border.js";
import { getModelContextLimits } from "../../model/modelRegistry.js";
import { useAnimationFrame } from "../../ink/hooks/use-animation-frame.js";
import { Box, Text } from "../ink.js";
import { TuiNodeState, TuiWorkflowNodeState } from "../state.js";
import { formatTokenCount } from "./StatusLine.js";

const RUNNING_TOP_RIGHT_FRAMES = ["◝", "◜", "◟", "◞"] as const;

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
  currentNodeId,
  suspendedStack = []
}: {
  nodes: TuiNodeState[];
  workflowNodes?: TuiWorkflowNodeState[];
  currentNodeId?: string;
  suspendedStack?: string[];
}) {
  const [animationRef, animationTime] = useAnimationFrame(nodes.some((node) => node.status === "running") ? 120 : null);
  const runningBorder: BorderStyle = { ...NODE_BORDER, topRight: RUNNING_TOP_RIGHT_FRAMES[Math.floor(animationTime / 120) % RUNNING_TOP_RIGHT_FRAMES.length] };
  const rows = workflowNodes?.length
    ? workflowNodes.map((node) => ({ id: node.id, model: node.model, effort: node.effort, contextLimit: node.contextLimit, state: latestNodeState(nodes, node.id) }))
    : nodes.map((node) => ({ id: node.nodeId, model: node.model, effort: undefined, contextLimit: node.contextLimit ?? getModelContextLimits(node.model ?? "").autoCompactLimit, state: node }));

  return (
    <Box ref={animationRef} flexWrap="wrap" flexShrink={0}>
      {rows.map((row, index) => {
        const active = row.id === currentNodeId;
        const running = row.state?.status === "running";
        const color = nodeColor(row.state, active);
        const contextTokens = Math.max(0, row.state?.contextTokens ?? 0);
        const contextLimit = row.state?.contextLimit ?? row.contextLimit ?? getModelContextLimits(row.model ?? "").autoCompactLimit;
        const contextPercent = Math.min(100, Math.max(0, Math.round((contextTokens / contextLimit) * 100)));
        const contextText = `context: ${formatTokenCount(contextTokens).toLowerCase()}/${formatTokenCount(contextLimit).toLowerCase()} (${contextPercent}%)`;
        return (
          <Box key={row.id} alignItems="center">
            <Box borderStyle={running ? runningBorder : "single"} borderColor={color} paddingX={1} minWidth={18} flexDirection="column">
              <Text color={color} bold={active} dimColor={!row.state}>{row.id}</Text>
              {row.model ? <Text color={color} dimColor={!row.state}>model: {row.model}{row.effort ? " " + row.effort : ""}</Text> : null}
              <Text color={color} dimColor={!row.state}>{contextText}</Text>
              <Text color={color} dimColor={!row.state}>{statusLabel(row.state)}</Text>
            </Box>
            {index < rows.length - 1 ? <Text dimColor> -&gt; </Text> : null}
          </Box>
        );
      })}
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
