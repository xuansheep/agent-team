import type { BorderStyle } from "../../ink/render-border.js";
import { useAnimationFrame } from "../../ink/hooks/use-animation-frame.js";
import { Box, Text } from "../ink.js";
import { TuiNodeState, TuiWorkflowNodeState } from "../state.js";

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
  currentNodeId
}: {
  nodes: TuiNodeState[];
  workflowNodes?: TuiWorkflowNodeState[];
  currentNodeId?: string;
}) {
  const [animationRef, animationTime] = useAnimationFrame(nodes.some((node) => node.status === "running") ? 120 : null);
  const runningBorder: BorderStyle = { ...NODE_BORDER, topRight: RUNNING_TOP_RIGHT_FRAMES[Math.floor(animationTime / 120) % RUNNING_TOP_RIGHT_FRAMES.length] };
  const rows = workflowNodes?.length
    ? workflowNodes.map((node) => ({ id: node.id, model: node.model, state: latestNodeState(nodes, node.id) }))
    : nodes.map((node) => ({ id: node.nodeId, model: undefined, state: node }));

  return (
    <Box ref={animationRef} flexWrap="wrap" flexShrink={0}>
      {rows.map((row, index) => {
        const active = row.id === currentNodeId;
        const running = row.state?.status === "running";
        const color = nodeColor(row.state, active);
        return (
          <Box key={row.id} alignItems="center">
            <Box borderStyle={running ? runningBorder : "single"} borderColor={color} paddingX={1} minWidth={18} flexDirection="column">
              <Text color={color} bold={active} dimColor={!row.state}>{row.id}</Text>
              {row.model ? <Text color={color} dimColor={!row.state}>model: {row.model}</Text> : null}
              <Text color={color} dimColor={!row.state}>{statusLabel(row.state)}</Text>
            </Box>
            {index < rows.length - 1 ? <Text dimColor> -&gt; </Text> : null}
          </Box>
        );
      })}
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
  if (node.status === "running") return `running #${node.attempt}`;
  if (node.status === "success") return `done #${node.attempt}`;
  if (node.status === "failure") return `failed #${node.attempt}`;
  if (node.status === "waiting_user") return `waiting user #${node.attempt}`;
  return `interrupted #${node.attempt}`;
}

function nodeColor(node: TuiNodeState | undefined, active: boolean): "cyan" | "green" | "red" | "yellow" | undefined {
  if (active) return "cyan";
  if (!node) return undefined;
  if (node.status === "success") return "green";
  if (node.status === "failure" || node.status === "interrupted") return "red";
  if (node.status === "waiting_user") return "yellow";
  return undefined;
}
