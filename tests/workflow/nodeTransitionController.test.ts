import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowConfig } from "../../src/config/schema.js";
import { NodeTransitionController } from "../../src/workflow/nodeTransitionController.js";
import type { NodeResult } from "../../src/team/nodeResult.js";

const workflow: WorkflowConfig = {
  nodes: [
    { id: "product", role: "product", provider: "default", permission_mode: "default" },
    { id: "ui", role: "ui", provider: "default", permission_mode: "default" },
    { id: "developer", role: "developer", provider: "default", permission_mode: "default" },
    { id: "tester", role: "tester", provider: "default", permission_mode: "default" }
  ],
  edges: [],
  max_rework_cycles: 10
};

describe("NodeTransitionController", () => {
  it("exposes user boundaries and adjacent node descriptors", () => {
    const controller = new NodeTransitionController();
    assert.deepEqual(controller.navigation(workflow, "product").previous, { kind: "user" });
    assert.deepEqual(controller.navigation(workflow, "ui").previous, { kind: "node", node_id: "product", role: "product" });
    assert.deepEqual(controller.navigation(workflow, "ui").next, { kind: "node", node_id: "developer", role: "developer" });
    assert.deepEqual(controller.navigation(workflow, "tester").next, { kind: "user" });
  });

  it("pushes a returning node and pops it when the upstream node moves forward", () => {
    const controller = new NodeTransitionController();
    const backward = controller.resolve({ workflow, nodeId: "ui", result: result("backward"), suspendedStack: [], reworkCount: 0, reworkLimit: 10 });
    assert.deepEqual(backward, { type: "node", target_node_id: "product", suspended_stack: ["ui"], rework_count: 1, resume: true });
    const forward = controller.resolve({ workflow, nodeId: "product", result: result("forward"), suspendedStack: ["ui"], reworkCount: 1, reworkLimit: 10 });
    assert.deepEqual(forward, { type: "node", target_node_id: "ui", suspended_stack: [], rework_count: 1, resume: true });
  });

  it("only lets the first node move backward with user questions", () => {
    const controller = new NodeTransitionController();
    const userResult = { ...result("backward"), feedback: { defects: [], change_requests: [] }, questions: [{ id: "q1", text: "请确认范围？", required: true }] };
    assert.equal(controller.resolve({ workflow, nodeId: "product", result: userResult, suspendedStack: [], reworkCount: 0, reworkLimit: 10 }).type, "user");
    assert.throws(
      () => controller.resolve({ workflow, nodeId: "ui", result: userResult, suspendedStack: [], reworkCount: 0, reworkLimit: 10 }),
      /only the first workflow node/i
    );
  });

  it("retries the current node without changing the suspended stack", () => {
    const controller = new NodeTransitionController();
    const retry = controller.resolve({ workflow, nodeId: "ui", result: result("retry"), suspendedStack: ["developer"], reworkCount: 2, reworkLimit: 10 });

    assert.deepEqual(retry, { type: "node", target_node_id: "ui", suspended_stack: ["developer"], rework_count: 3, resume: true });
  });

  it("requires actionable feedback for retry and shares the rework limit", () => {
    const controller = new NodeTransitionController();
    assert.throws(
      () => controller.resolve({ workflow, nodeId: "ui", result: { ...result("retry"), feedback: { defects: [], change_requests: [] } }, suspendedStack: [], reworkCount: 0, reworkLimit: 10 }),
      /retry node results must include/
    );
    assert.equal(controller.resolve({ workflow, nodeId: "ui", result: result("retry"), suspendedStack: [], reworkCount: 10, reworkLimit: 10 }).type, "rework_limit");
  });

  it("pauses a backward transition at the configured rework limit", () => {
    const controller = new NodeTransitionController();
    assert.equal(controller.resolve({ workflow, nodeId: "ui", result: result("backward"), suspendedStack: [], reworkCount: 10, reworkLimit: 10 }).type, "rework_limit");
  });
});

function result(direction: NodeResult["direction"]): NodeResult {
  return {
    direction,
    summary: "done",
    document: direction === "forward" ? "# Result" : "",
    deliverables: [],
    feedback: direction === "backward" || direction === "retry" ? { defects: ["PRD缺少异常流程"], change_requests: [] } : { defects: [], change_requests: [] },
    questions: [],
    handoff: { instruction: direction === "backward" || direction === "retry" ? "补充异常流程" : "继续", must_follow: [], known_risks: [], open_questions: [] }
  };
}
