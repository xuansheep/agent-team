import type { WorkflowConfig, WorkflowNodeConfig } from "../config/schema.js";
import type { NodeResult } from "../team/nodeResult.js";

export type NodeNeighbor =
  | { kind: "user" }
  | { kind: "node"; node_id: string; role: string };

export type NodeNavigation = {
  current: { node_id: string; role: string; position: number };
  previous: NodeNeighbor;
  next: NodeNeighbor;
};

export type TransitionResolution =
  | { type: "node"; target_node_id: string; suspended_stack: string[]; rework_count: number; resume: boolean }
  | { type: "user"; suspended_stack: string[]; rework_count: number }
  | { type: "complete"; suspended_stack: string[]; rework_count: number }
  | { type: "rework_limit"; suspended_stack: string[]; rework_count: number };

export class NodeTransitionController {
  navigation(workflow: WorkflowConfig, nodeId: string): NodeNavigation {
    const index = this.nodeIndex(workflow, nodeId);
    const node = workflow.nodes[index]!;
    return {
      current: { node_id: node.id, role: node.role, position: index },
      previous: index === 0 ? { kind: "user" } : nodeNeighbor(workflow.nodes[index - 1]!),
      next: index === workflow.nodes.length - 1 ? { kind: "user" } : nodeNeighbor(workflow.nodes[index + 1]!)
    };
  }

  resolve(input: {
    workflow: WorkflowConfig;
    nodeId: string;
    result: NodeResult;
    suspendedStack: string[];
    reworkCount: number;
    reworkLimit: number;
    bypassReworkLimit?: boolean;
  }): TransitionResolution {
    const navigation = this.navigation(input.workflow, input.nodeId);
    this.assertResultForBoundary(navigation, input.result);

    if (input.result.direction === "retry") {
      if (!input.bypassReworkLimit && input.reworkCount >= input.reworkLimit) {
        return { type: "rework_limit", suspended_stack: input.suspendedStack, rework_count: input.reworkCount };
      }
      return {
        type: "node",
        target_node_id: input.nodeId,
        suspended_stack: input.suspendedStack,
        rework_count: input.reworkCount + 1,
        resume: true
      };
    }

    if (input.result.direction === "backward") {
      if (navigation.previous.kind === "user") {
        return { type: "user", suspended_stack: input.suspendedStack, rework_count: input.reworkCount };
      }
      if (!input.bypassReworkLimit && input.reworkCount >= input.reworkLimit) {
        return { type: "rework_limit", suspended_stack: input.suspendedStack, rework_count: input.reworkCount };
      }
      return {
        type: "node",
        target_node_id: navigation.previous.node_id,
        suspended_stack: [...input.suspendedStack, input.nodeId],
        rework_count: input.reworkCount + 1,
        resume: true
      };
    }

    if (navigation.next.kind === "user") {
      if (input.suspendedStack.length) {
        throw new Error(`Cannot complete workflow while suspended nodes remain: ${input.suspendedStack.join(", ")}`);
      }
      return { type: "complete", suspended_stack: input.suspendedStack, rework_count: input.reworkCount };
    }

    const stack = [...input.suspendedStack];
    const resume = stack.at(-1) === navigation.next.node_id;
    if (resume) stack.pop();
    return {
      type: "node",
      target_node_id: navigation.next.node_id,
      suspended_stack: stack,
      rework_count: input.reworkCount,
      resume
    };
  }

  private assertResultForBoundary(navigation: NodeNavigation, result: NodeResult): void {
    if (result.direction === "forward" && result.questions.length) {
      throw new Error("forward node results must not contain user questions");
    }
    if (result.direction === "retry") {
      if (result.questions.length) throw new Error("retry node results must not contain user questions");
      if (!result.feedback.defects.length && !result.feedback.change_requests.length) {
        throw new Error("retry node results must include a defect or change request");
      }
      if (!result.handoff.instruction.trim()) {
        throw new Error("retry node results must include a handoff instruction");
      }
      return;
    }
    if (result.direction !== "backward") return;
    if (navigation.previous.kind === "user") {
      if (!result.questions.some((question) => question.text.trim())) {
        throw new Error("the first workflow node must include a concrete user question when moving backward");
      }
      return;
    }
    if (result.questions.length) {
      throw new Error("only the first workflow node may ask the user questions");
    }
    if (!result.feedback.defects.length && !result.feedback.change_requests.length) {
      throw new Error("backward node results must include a defect or change request");
    }
    if (!result.handoff.instruction.trim()) {
      throw new Error("backward node results must include a handoff instruction");
    }
  }

  private nodeIndex(workflow: WorkflowConfig, nodeId: string): number {
    const index = workflow.nodes.findIndex((node) => node.id === nodeId);
    if (index < 0) throw new Error(`Unknown node ${nodeId}`);
    return index;
  }
}

function nodeNeighbor(node: WorkflowNodeConfig): NodeNeighbor {
  return { kind: "node", node_id: node.id, role: node.role };
}
