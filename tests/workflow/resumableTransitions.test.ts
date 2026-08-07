import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentTeamConfig } from "../../src/config/schema.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { WorkflowEngine, workflowConfigFingerprint } from "../../src/workflow/engine.js";
import { testDispatcher } from "../helpers/projectConfig.js";

describe("resumable workflow transitions", () => {
  it("resumes product and UI in the same attempts after UI returns a PRD issue", async () => {
    const requests: ModelRequest[] = [];
    let call = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        call += 1;
        if (call === 1) return response("forward", "PRD v1", "UI开始设计");
        if (call === 2) return response("backward", "PRD缺少错误态", "补充错误态", ["缺少错误态"]);
        if (call === 3) return response("forward", "PRD v2已补充", "按PRD v2继续");
        if (call === 4) return response("forward", "设计完成", "进入开发");
        if (call === 5) return response("forward", "开发完成", "进入测试");
        return response("forward", "测试通过", "交付用户", [], "# 最终交付\n\n验证通过。");
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/resumable-flow-${Date.now()}` });
    const state = await engine.run(config(), "delivery", { request: "实现新功能" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(state.rework_count, 1);
    assert.deepEqual(state.suspended_stack, []);
    assert.deepEqual(state.attempts.map((item) => [item.node_id, item.attempt, item.activation]), [
      ["product", 1, 2],
      ["ui", 1, 2],
      ["developer", 1, 1],
      ["tester", 1, 1]
    ]);
    assert.deepEqual(state.attempts.find((item) => item.node_id === "ui")?.activations?.map((item) => item.status), ["returned", "forwarded"]);
    assert.match(JSON.stringify(requests[2]?.messages), /PRD缺少错误态/);
    assert.match(JSON.stringify(requests[3]?.messages), /PRD v2已补充/);
    assert.match(JSON.stringify(requests[3]?.messages), /@r1/);
  });

  it("keeps SubmitNodeResult history valid and makes the latest return handoff authoritative", async () => {
    let call = 0;
    const requests: ModelRequest[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        assertResolvedToolCalls(request.messages);
        call += 1;
        if (call === 1) return submittedResponse("product-1", "forward", "PRD ready", "Start UI");
        if (call === 2) return submittedResponse("ui-1", "forward", "Design ready", "实现4卡布局");
        if (call === 3) return submittedResponse("developer-1", "forward", "Implementation ready", "Verify");
        if (call === 4) return submittedResponse("tester-1", "backward", "Layout defect", "修复为8卡布局", ["Only four cards"]);
        if (call === 5) return submittedResponse("developer-2", "forward", "Layout fixed", "Retest");
        return submittedResponse("tester-2", "forward", "Verification passed", "Deliver", [], "# Delivery\n\nVerified.");
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/resumable-submit-result-${Date.now()}` });
    const state = await engine.run(config(), "delivery", { request: "Implement and verify" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(state.rework_count, 1);
    assert.equal(state.attempts.find((attempt) => attempt.node_id === "developer")?.activation, 2);
    assert.equal(state.attempts.find((attempt) => attempt.node_id === "tester")?.activation, 2);
    const resumedDeveloperContext = requests[4]?.messages.find((message) =>
      message.role === "user"
      && typeof message.content === "string"
      && message.content.includes('"node_id": "developer"')
    );
    assert.ok(resumedDeveloperContext && typeof resumedDeveloperContext.content === "string");
    const resumedHandoff = JSON.parse(resumedDeveloperContext.content).handoff as {
      instruction?: string;
      previous_handoff?: { instruction?: string };
    };
    assert.equal(resumedHandoff.instruction, "修复为8卡布局");
    assert.equal(resumedHandoff.previous_handoff?.instruction, "实现4卡布局");
  });

  it("retries the current node in the same attempt with a new activation", async () => {
    const requests: ModelRequest[] = [];
    let call = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        call += 1;
        if (call === 1) return response("retry", "需要继续完善 PRD", "补充验收标准", ["缺少验收标准"]);
        if (call === 2) return response("forward", "PRD 已完善", "进入验收");
        return response("forward", "验收通过", "交付", [], "# 结果\n\n已完成。");
      }
    };
    const retryConfig = config();
    retryConfig.workflows.delivery.nodes = [retryConfig.workflows.delivery.nodes[0]!, { ...retryConfig.workflows.delivery.nodes[3]!, id: "tester" }];
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/retry-current-node-${Date.now()}` });
    const state = await engine.run(retryConfig, "delivery", { request: "完善并验收" });

    assert.equal(state.status, "awaiting_bus");
    assert.equal(state.rework_count, 1);
    assert.deepEqual(state.suspended_stack, []);
    const product = state.attempts.find((item) => item.node_id === "product");
    assert.equal(product?.attempt, 1);
    assert.equal(product?.activation, 2);
    assert.deepEqual(product?.activations?.map((item) => item.status), ["retrying", "forwarded"]);
    assert.match(JSON.stringify(requests[1]?.messages), /补充验收标准/);
  });

  it("waits for the user only at the first node and resumes its conversation", async () => {
    const requests: ModelRequest[] = [];
    let call = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        call += 1;
        if (call === 1) {
          return {
            content: JSON.stringify({
              direction: "backward",
              summary: "需要用户确认",
              questions: [{ id: "scope", text: "是否包含移动端？", required: true }],
              handoff: { instruction: "等待范围确认" }
            })
          };
        }
        return response("forward", "范围已确认", "完成", [], "# 最终结果\n\n包含移动端。");
      }
    };
    const runRoot = `.tmp/resumable-user-${Date.now()}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const single = config();
    single.workflows.delivery.nodes = [{ id: "product", role: "product", provider: "default", permission_mode: "default" }];
    const waiting = await engine.run(single, "delivery", { request: "定义范围" });

    assert.equal(waiting.status, "waiting_user");
    assert.equal(waiting.pending_interaction?.type, "node_user");
    const completed = await engine.resume(single, "delivery", await latestRunId(engine), { answer: "包含移动端" });
    assert.equal(completed.status, "awaiting_bus");
    assert.equal(completed.attempts[0]?.attempt, 1);
    assert.equal(completed.attempts[0]?.activation, 2);
    assert.match(JSON.stringify(requests[1]?.messages), /包含移动端/);
  });

  it("pauses at the rework limit and lets the user cancel the run", async () => {
    let call = 0;
    const provider: ModelProvider = {
      async generate() {
        call += 1;
        if (call === 1 || call === 3) return response("forward", `PRD revision ${call}`, "继续UI");
        return response("backward", `UI issue ${call}`, "修订PRD", ["仍有缺失"]);
      }
    };
    const runRoot = `.tmp/rework-limit-${Date.now()}`;
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot });
    const limited = config();
    limited.workflows.delivery.nodes = limited.workflows.delivery.nodes.slice(0, 2);
    limited.workflows.delivery.max_rework_cycles = 1;
    const waiting = await engine.run(limited, "delivery", { request: "反复确认" });

    assert.equal(waiting.status, "waiting_user");
    assert.equal(waiting.pending_interaction?.type, "rework_limit");
    const cancelled = await engine.resume(limited, "delivery", (await engine.listRuns({ limit: 1 }))[0]!.runId, { decision: "cancel" });
    assert.equal(cancelled.status, "cancelled");
    assert.equal(call, 4);
  });

  it("resumes with the current role and global prompt after configuration changes", async () => {
    const requests: ModelRequest[] = [];
    let call = 0;
    const provider: ModelProvider = {
      async generate(request) {
        requests.push(request);
        call += 1;
        if (call === 1) return response("backward", "需要确认", "询问用户");
        return response("forward", "确认完成", "交付", [], "# 最终结果\n\n已按当前配置完成。");
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => provider, cwd: process.cwd(), runRoot: `.tmp/config-fingerprint-${Date.now()}` });
    const original = config();
    original.workflows.delivery.nodes = original.workflows.delivery.nodes.slice(0, 1);
    await engine.run(original, "delivery", { request: "定义范围" });
    const changed = config();
    changed.workflows.delivery.nodes = changed.workflows.delivery.nodes.slice(0, 1);
    changed.global_prompt = "current global prompt";
    changed.roles.product = { ...changed.roles.product, system_prompt: "current role prompt" };
    const runId = await latestRunId(engine);

    const resumed = await engine.resume(changed, "delivery", runId, { answer: "继续" });

    assert.equal(resumed.status, "awaiting_bus");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]?.messages), /current global prompt/);
    assert.match(JSON.stringify(requests[1]?.messages), /current role prompt/);
    assert.equal(resumed.config_fingerprint, workflowConfigFingerprint(changed, "delivery"));
  });
});

function submittedResponse(id: string, direction: "forward" | "backward", summary: string, instruction: string, defects: string[] = [], document = "") {
  return {
    tool_calls: [{
      id,
      name: "SubmitNodeResult",
      input: {
        direction,
        summary,
        document,
        deliverables: [],
        feedback: { defects, change_requests: [] },
        questions: [],
        handoff: { instruction, must_follow: [], known_risks: [], open_questions: [] }
      }
    }]
  };
}

function assertResolvedToolCalls(messages: ModelRequest["messages"]): void {
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const unresolved = new Set(message.tool_calls.map((call) => call.id));
    for (let nextIndex = index + 1; nextIndex < messages.length && unresolved.size; nextIndex += 1) {
      const next = messages[nextIndex];
      if (next.role === "tool" && next.tool_call_id) {
        unresolved.delete(next.tool_call_id);
        continue;
      }
      if (next.role === "user" || next.role === "assistant") break;
    }
    assert.deepEqual([...unresolved], []);
  }
}

function response(direction: "forward" | "backward" | "retry", summary: string, instruction: string, defects: string[] = [], document = "") {
  return {
    content: JSON.stringify({
      direction,
      summary,
      document,
      deliverables: [],
      feedback: { defects, change_requests: [] },
      questions: [],
      handoff: { instruction, must_follow: [], known_risks: [], open_questions: [] }
    })
  };
}

function config(): AgentTeamConfig {
  const role = (system_prompt: string) => ({ description: "", system_prompt, requires: { tool_calling: false, vision: false } });
  return {
    providers: {
      default: {
        type: "openai-compatible",
        base_url: "https://api.example.test/v1",
        api_key: "test-key",
        default_model: "gpt-test",
        capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
      }
    },
    dispatcher: testDispatcher,
    roles: { product: role("P"), ui: role("U"), developer: role("D"), tester: role("T") },
    workflows: {
      delivery: {
        nodes: [
          { id: "product", role: "product", provider: "default", permission_mode: "default" },
          { id: "ui", role: "ui", provider: "default", permission_mode: "default" },
          { id: "developer", role: "developer", provider: "default", permission_mode: "default" },
          { id: "tester", role: "tester", provider: "default", permission_mode: "default" }
        ],
        edges: [],
        max_rework_cycles: 10
      }
    }
  };
}

async function latestRunId(engine: WorkflowEngine): Promise<string> {
  const run = (await engine.listRuns({ limit: 1 }))[0];
  if (!run) throw new Error("Expected a workflow run");
  return run.runId;
}
