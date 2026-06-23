import React from "react";
import { Box, Text } from "../ink.js";
import { TuiNodeState, TuiWorkflowNodeState } from "../state.js";

export function WorkflowFlowChart({
  nodes,
  workflowNodes,
  currentNodeId
}: {
  nodes: TuiNodeState[];
  workflowNodes?: TuiWorkflowNodeState[];
  currentNodeId?: string;
}) {
  const rows = workflowNodes?.length
    ? workflowNodes.map((node) => ({ id: node.id, state: latestNodeState(nodes, node.id) }))
    : nodes.map((node) => ({ id: node.nodeId, state: node }));

  return (
    <Box flexWrap="wrap" flexShrink={0}>
      {rows.map((row, index) => {
        const active = row.id === currentNodeId;
        return (
          <Box key={row.id} alignItems="center">
            <Box borderStyle="single" borderColor={nodeColor(row.state, active)} paddingX={1} minWidth={16} flexDirection="column">
              <Text color={nodeColor(row.state, active)} bold={active} dimColor={!row.state}>{row.id}</Text>
              <Text color={nodeColor(row.state, active)} dimColor={!row.state}>{statusLabel(row.state)}</Text>
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
  if (!node) return "等待中";
  if (node.status === "running") return `运行中 #${node.attempt}`;
  if (node.status === "success") return `已完成 #${node.attempt}`;
  if (node.status === "failure") return `失败 #${node.attempt}`;
  if (node.status === "waiting_user") return `等待用户 #${node.attempt}`;
  if (node.status === "waiting_plan_review") return `计划待审 #${node.attempt}`;
  return `已中断 #${node.attempt}`;
}

function nodeColor(node: TuiNodeState | undefined, active: boolean): "cyan" | "green" | "red" | "yellow" | undefined {
  if (active) return "cyan";
  if (!node) return undefined;
  if (node.status === "success") return "green";
  if (node.status === "failure" || node.status === "interrupted") return "red";
  if (node.status === "waiting_user" || node.status === "waiting_plan_review") return "yellow";
  return undefined;
}
