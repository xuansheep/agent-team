import { z } from "zod";
import {
  dispatcherConfigSchema,
  type AgentTeamConfig,
  type DispatcherConfig,
  type WorkflowConfig
} from "../config/schema.js";
import type { ModelMessage, ModelProvider, ModelRetryEvent } from "../providers/types.js";
import type { SessionStore } from "../storage/sessionStore.js";
import type { Tool } from "../tools/types.js";
import type { WorkflowRunDossier } from "../workflow/dossier.js";
import type { BusEvent, DispatchDirective, TaskSummary } from "./busTypes.js";
import { TurnEngine } from "./turnEngine.js";

export type DispatcherPhase = "user" | "plan" | "lifecycle";
export type DispatcherClarificationReason = "low_confidence" | "dispatcher_failure" | "invalid_directive";

export type DispatcherRequest = {
  config: AgentTeamConfig;
  workflowId: string;
  sessionId: string;
  runId?: string;
  phase: DispatcherPhase;
  messages: ModelMessage[];
  dossier?: WorkflowRunDossier;
  providerFactory: (providerId: string) => ModelProvider;
  turnEngine?: TurnEngine;
  sessionStore?: SessionStore;
  eventSink?: (event: BusEvent) => void | Promise<void>;
};

export type DispatcherSelection = {
  directive: DispatchDirective;
  clarificationReason?: DispatcherClarificationReason;
};

const confidenceSchema = z.number().min(0).max(1);
const answerSchema = z.object({
  type: z.literal("answer"),
  confidence: confidenceSchema,
  message: z.string().trim().min(1)
}).strict();
const clarifySchema = z.object({
  type: z.literal("clarify"),
  confidence: confidenceSchema,
  message: z.string().trim().min(1)
}).strict();
const planSchema = z.object({
  type: z.literal("plan"),
  confidence: confidenceSchema,
  node_id: z.string().trim().min(1),
  reason: z.string().trim().min(1)
}).strict();
const dispatchSchema = z.object({
  type: z.literal("dispatch"),
  confidence: confidenceSchema,
  node_id: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  reason: z.string().trim().min(1)
}).strict();
const taskSummarySchema = z.object({
  summary: z.string().trim().min(1),
  outcomes: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  residual_risks: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([])
}).strict();
const finalizeSchema = z.object({
  type: z.literal("finalize"),
  confidence: confidenceSchema,
  summary: taskSummarySchema
}).strict();
const contentDirectiveSchema = z.discriminatedUnion("type", [
  answerSchema,
  clarifySchema,
  planSchema,
  dispatchSchema,
  finalizeSchema
]);

const selectToolInputSchema = z.object({
  node_id: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  confidence: confidenceSchema
}).strict();
const dispatchToolInputSchema = z.object({
  node_id: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  confidence: confidenceSchema
}).strict();
const finalizeToolInputSchema = z.object({
  summary: z.string().trim().min(1),
  outcomes: z.array(z.string()).default([]),
  verification: z.array(z.string()).default([]),
  residual_risks: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  confidence: confidenceSchema
}).strict();

export async function requestDispatchDirective(input: DispatcherRequest): Promise<DispatcherSelection> {
  const workflow = input.config.workflows[input.workflowId];
  if (!workflow) {
    return invalidSelection(`Unknown workflow ${input.workflowId}`);
  }
  let dispatcher: DispatcherConfig;
  try {
    dispatcher = dispatcherConfigSchema.parse({ ...input.config.dispatcher, ...workflow.dispatcher });
  } catch (error) {
    return failedSelection(error);
  }
  const providerConfig = input.config.providers[dispatcher.provider];
  if (!providerConfig) return failedSelection(new Error(`Unknown dispatcher provider ${dispatcher.provider}`));

  const tools = providerConfig.capabilities.tool_calling ? dispatcherTools() : [];
  const engine = input.turnEngine ?? new TurnEngine();
  await input.eventSink?.({
    type: "bus_routing_started",
    session_id: input.sessionId,
    workflow_id: input.workflowId,
    phase: input.phase
  });

  try {
    const { response } = await engine.requestModel({
      provider: input.providerFactory(dispatcher.provider),
      request: {
        model: dispatcher.model,
        effort: dispatcher.effort,
        messages: dispatcherMessages(input, workflow),
        tools,
        ...(!tools.length && providerConfig.capabilities.json_schema_output
          ? { response_schema: dispatcherDirectiveJsonSchema }
          : {}),
        context: {
          runId: input.runId ?? input.sessionId,
          nodeId: "bus",
          attempt: 1,
          sessionId: input.sessionId,
          threadId: input.sessionId,
          turnId: `${input.sessionId}:bus:${Date.now()}`,
          promptCacheKey: `${input.sessionId}:bus`
        },
        onRetry: (retry) => emitRetry(input, retry)
      }
    });
    await input.sessionStore?.recordModelResponse(input.sessionId, response.usage);
    const parsed = parseDispatcherResponse(response.tool_calls ?? [], response.content);
    if (!parsed) return invalidSelection("Dispatcher response did not contain one valid directive");
    if (parsed.confidence < dispatcher.confidence_threshold) {
      return {
        directive: {
          type: "clarify",
          confidence: parsed.confidence,
          message: parsed.type === "clarify"
            ? parsed.message
            : "我暂时无法可靠判断应如何路由这条消息。请补充期望结果，或明确希望从哪个工作流节点开始。"
        },
        clarificationReason: "low_confidence"
      };
    }
    return { directive: parsed };
  } catch (error) {
    return failedSelection(error);
  }
}

function dispatcherMessages(input: DispatcherRequest, workflow: WorkflowConfig): ModelMessage[] {
  const nodeCatalog = workflow.nodes.map((node, index) => ({
    position: index,
    id: node.id,
    role: node.role,
    role_description: input.config.roles[node.role]?.description ?? ""
  }));
  const phaseRules = input.phase === "plan"
    ? "The user is in Plan Mode. Select the best workflow node for eventual execution with SelectWorkflowNode. Never dispatch or finalize before plan approval."
    : input.phase === "lifecycle"
      ? "The workflow is at a bus boundary. Read the full dossier. Either dispatch one concrete node for rework with DispatchWorkflowNode, or finish with FinalizeTask. Do not answer outside those tools."
      : "Route the user message. You may answer directly, ask for clarification, select a node for Plan Mode, or dispatch a workflow node.";
  const busPrompt = [
    "You are the session execution bus. The user communicates only with you.",
    "You own workflow routing, lifecycle decisions, process-safe node reassignment, and the final task summary.",
    "Never silently fall back to the first node. Every directive must include confidence from 0 to 1.",
    "Use SelectWorkflowNode to enter or continue Plan Mode while dynamically updating the planned start node.",
    "Use DispatchWorkflowNode to start or reassign execution at an explicit node.",
    "Use FinalizeTask only after the dossier supports a complete final answer.",
    "For a direct answer or clarification, return exactly one JSON object matching the DispatchDirective schema.",
    phaseRules,
    `Workflow: ${input.workflowId}`,
    `Nodes: ${JSON.stringify(nodeCatalog)}`
  ].join("\n");
  const system = [input.config.global_prompt?.trim(), busPrompt].filter(Boolean).join("\n\n");
  const dossierMessage: ModelMessage[] = input.dossier
    ? [{
        role: "user",
        metadata: { userMessageKind: "runtime_context", durableRuntimeContext: true },
        content: JSON.stringify({ type: "workflow_run_dossier", dossier: input.dossier })
      }]
    : [];
  return [{ role: "system", content: system }, ...input.messages, ...dossierMessage];
}

function parseDispatcherResponse(toolCalls: Array<{ id: string; name: string; input: unknown }>, content: string | undefined): DispatchDirective | undefined {
  if (toolCalls.length) {
    if (toolCalls.length !== 1) return undefined;
    const call = toolCalls[0]!;
    if (call.name === "SelectWorkflowNode") {
      const value = selectToolInputSchema.safeParse(call.input);
      return value.success ? { type: "plan", ...value.data } : undefined;
    }
    if (call.name === "DispatchWorkflowNode") {
      const value = dispatchToolInputSchema.safeParse(call.input);
      return value.success ? { type: "dispatch", ...value.data } : undefined;
    }
    if (call.name === "FinalizeTask") {
      const value = finalizeToolInputSchema.safeParse(call.input);
      if (!value.success) return undefined;
      const { confidence, ...summary } = value.data;
      return { type: "finalize", confidence, summary };
    }
    return undefined;
  }
  if (!content?.trim()) return undefined;
  try {
    return contentDirectiveSchema.parse(JSON.parse(content));
  } catch {
    return undefined;
  }
}

function dispatcherTools(): Tool[] {
  return [
    directiveTool(
      "SelectWorkflowNode",
      "Select the workflow node that should execute after Plan Mode is approved.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          node_id: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["node_id", "reason", "confidence"]
      }
    ),
    directiveTool(
      "DispatchWorkflowNode",
      "Start or reassign workflow execution at an explicit node.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          node_id: { type: "string" },
          instruction: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["node_id", "instruction", "reason", "confidence"]
      }
    ),
    directiveTool(
      "FinalizeTask",
      "Finalize the task from the complete workflow dossier.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string" },
          outcomes: { type: "array", items: { type: "string" } },
          verification: { type: "array", items: { type: "string" } },
          residual_risks: { type: "array", items: { type: "string" } },
          artifacts: { type: "array", items: { type: "string" } },
          confidence: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["summary", "outcomes", "verification", "residual_risks", "artifacts", "confidence"]
      }
    )
  ];
}

function directiveTool(name: string, description: string, input_schema: Record<string, unknown>): Tool {
  return {
    name,
    description,
    input_schema,
    async execute(value) {
      return { data: value };
    }
  };
}

function invalidSelection(_detail: string): DispatcherSelection {
  return {
    directive: {
      type: "clarify",
      confidence: 0,
      message: "调度模型没有返回可验证的路由决策。请明确希望直接答复、进入计划模式，或指定执行节点。"
    },
    clarificationReason: "invalid_directive"
  };
}

function failedSelection(_error: unknown): DispatcherSelection {
  return {
    directive: {
      type: "clarify",
      confidence: 0,
      message: "调度模型暂时无法可靠处理这条消息。请补充期望结果或指定工作流节点后重试。"
    },
    clarificationReason: "dispatcher_failure"
  };
}

async function emitRetry(input: DispatcherRequest, retry: ModelRetryEvent): Promise<void> {
  await input.eventSink?.({
    type: "bus_dispatcher_retry_scheduled",
    session_id: input.sessionId,
    workflow_id: input.workflowId,
    retry_attempt: retry.retryAttempt,
    max_retries: retry.maxRetries,
    retry_in_ms: retry.retryInMs,
    error: retry.message
  });
}

const dispatcherDirectiveJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: ["answer", "clarify", "plan", "dispatch", "finalize"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    message: { type: "string" },
    node_id: { type: "string" },
    reason: { type: "string" },
    instruction: { type: "string" },
    summary: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string" },
        outcomes: { type: "array", items: { type: "string" } },
        verification: { type: "array", items: { type: "string" } },
        residual_risks: { type: "array", items: { type: "string" } },
        artifacts: { type: "array", items: { type: "string" } }
      },
      required: ["summary", "outcomes", "verification", "residual_risks", "artifacts"]
    }
  },
  required: ["type", "confidence"]
} as const;

export function renderTaskSummary(summary: TaskSummary): string {
  const sections = [summary.summary.trim()];
  if (summary.outcomes.length) sections.push(["## Outcomes", ...summary.outcomes.map((item) => `- ${item}`)].join("\n"));
  if (summary.verification.length) sections.push(["## Verification", ...summary.verification.map((item) => `- ${item}`)].join("\n"));
  if (summary.residual_risks.length) sections.push(["## Residual risks", ...summary.residual_risks.map((item) => `- ${item}`)].join("\n"));
  if (summary.artifacts.length) sections.push(["## Artifacts", ...summary.artifacts.map((item) => `- ${item}`)].join("\n"));
  return sections.filter(Boolean).join("\n\n");
}
