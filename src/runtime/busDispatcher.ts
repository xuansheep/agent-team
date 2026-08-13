import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  dispatcherConfigSchema,
  type AgentTeamConfig,
  type DispatcherConfig,
  type ExecutionKind,
  type WorkflowConfig
} from "../config/schema.js";
import type { ModelMessage, ModelProvider, ModelRetryEvent } from "../providers/types.js";
import type { SessionStore } from "../storage/sessionStore.js";
import type { Tool } from "../tools/types.js";
import { compactWorkflowRunDossier, type WorkflowRunDossier } from "../workflow/dossier.js";
import type { WorkflowState } from "../workflow/state.js";
import type {
  BusEvent,
  DispatchDirective,
  SessionBusCheckpoint,
  TaskSummary
} from "./busTypes.js";
import { TurnEngine } from "./turnEngine.js";

export type DispatcherPhase = "user" | "plan" | "lifecycle";
export type DispatcherClarificationReason = "material_ambiguity";

export type DispatcherRequest = {
  config: AgentTeamConfig;
  workflowId: string;
  executionKind?: ExecutionKind;
  sessionId: string;
  runId?: string;
  phase: DispatcherPhase;
  messages: ModelMessage[];
  dossier?: WorkflowRunDossier;
  providerFactory: (providerId: string) => ModelProvider;
  turnEngine?: TurnEngine;
  signal?: AbortSignal;
  sessionStore?: SessionStore;
  eventSink?: (event: BusEvent) => void | Promise<void>;
  runtimeContext?: DispatcherRuntimeContext;
};

export type DispatcherRuntimeContext = {
  bus: SessionBusCheckpoint;
  workflow?: {
    run_id: string;
    status: WorkflowState["status"];
    current_node_id?: string;
    rework_count: number;
    pending_interaction?: WorkflowState["pending_interaction"];
    latest_attempt?: WorkflowState["attempts"][number];
    final_summary?: string;
  };
};

export type DispatcherSelection = {
  directive: DispatchDirective;
  clarificationReason?: DispatcherClarificationReason;
  routingId: string;
  phase: DispatcherPhase;
  thinking?: string;
  responseShape?: string;
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
  reason: z.string().trim().min(1),
  destructive_policy: z.enum(["ask", "deny"]).optional()
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

const answerToolInputSchema = answerSchema.omit({ type: true });
const clarifyToolInputSchema = clarifySchema.omit({ type: true });

const selectToolInputSchema = z.object({
  node_id: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  confidence: confidenceSchema
}).strict();
const dispatchToolInputSchema = z.object({
  node_id: z.string().trim().min(1),
  instruction: z.string().trim().min(1),
  reason: z.string().trim().min(1),
  confidence: confidenceSchema,
  destructive_policy: z.enum(["ask", "deny"]).optional()
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
  const routingId = randomUUID();
  const executionKind = input.executionKind ?? "workflow";
  const workflow = executionKind === "team" ? input.config.teams?.[input.workflowId] : input.config.workflows[input.workflowId];
  if (!workflow) {
    return failedSelection(`Unknown ${executionKind} ${input.workflowId}`, input.phase, routingId, "configuration");
  }
  let dispatcher: DispatcherConfig;
  try {
    dispatcher = dispatcherConfigSchema.parse({ ...input.config.dispatcher, ...workflow.dispatcher });
  } catch (error) {
    return failedSelection(error, input.phase, routingId, "configuration");
  }
  const providerConfig = input.config.providers[dispatcher.provider];
  if (!providerConfig) {
    return failedSelection(`Unknown dispatcher provider ${dispatcher.provider}`, input.phase, routingId, "configuration");
  }
  if (!providerConfig.capabilities.tool_calling && !providerConfig.capabilities.json_schema_output) {
    return failedSelection(
      `Dispatcher provider ${dispatcher.provider} supports neither tool calling nor JSON schema output`,
      input.phase,
      routingId,
      "configuration"
    );
  }

  const tools = providerConfig.capabilities.tool_calling ? dispatcherTools(input.phase) : [];
  const engine = input.turnEngine ?? new TurnEngine();
  await input.eventSink?.({
    type: "bus_routing_started",
    session_id: input.sessionId,
    workflow_id: input.workflowId,
    routing_id: routingId,
    phase: input.phase
  });

  let lowConfidenceFallback: DispatchDirective | undefined;
  let fallbackThinking: string | undefined;
  let correction: ModelMessage | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      input.signal?.throwIfAborted();
      let streamEvents = Promise.resolve();
      const { streamed, response } = await engine.requestModel({
        provider: input.providerFactory(dispatcher.provider),
        request: {
          model: dispatcher.model,
          effort: dispatcher.effort,
          messages: [...dispatcherMessages(input, workflow), ...(correction ? [correction] : [])],
          tools,
          ...(tools.length ? { toolChoice: "required" as const, parallelToolCalls: false } : {}),
          ...(!tools.length ? { response_schema: dispatcherDirectiveJsonSchema(input.phase) } : {}),
          context: {
            runId: input.runId ?? input.sessionId,
            nodeId: "bus",
            attempt: attempt + 1,
            sessionId: input.sessionId,
            threadId: input.sessionId,
            turnId: `${input.sessionId}:bus:${Date.now()}:${attempt + 1}`,
            promptCacheKey: `${input.sessionId}:bus`
          },
          signal: input.signal,
          onRetry: async (retry) => {
            await streamEvents;
            await emitRetry(input, retry, routingId);
          }
        },
        onStreamEvent: (event) => {
          if (event.type !== "thinking_delta" || !event.text) return;
          streamEvents = streamEvents.then(async () => {
            await input.eventSink?.({
              type: "bus_model_thinking_delta",
              session_id: input.sessionId,
              workflow_id: input.workflowId,
              routing_id: routingId,
              text: event.text
            });
          });
        }
      });
      await streamEvents;
      if (!streamed && response.thinking) {
        await input.eventSink?.({
          type: "bus_model_thinking_delta",
          session_id: input.sessionId,
          workflow_id: input.workflowId,
          routing_id: routingId,
          text: response.thinking
        });
      }
      input.signal?.throwIfAborted();
      await input.sessionStore?.recordModelResponse(input.sessionId, response.usage);

      const parsed = parseDispatcherResponse(response.tool_calls ?? [], response.content);
      const valid = parsed
        && directiveAllowedForPhase(parsed, input.phase)
        && directiveTargetsKnownNode(parsed, workflow);
      if (valid && parsed.confidence >= dispatcher.confidence_threshold) {
        return {
          directive: parsed,
          routingId,
          phase: input.phase,
          ...(response.thinking ? { thinking: response.thinking } : {})
        };
      }
      if (valid && parsed.type !== "clarify") {
        lowConfidenceFallback = parsed;
        fallbackThinking = response.thinking;
      }
      if (attempt === 0) {
        const retryReason = valid ? "low_confidence" : "invalid_response";
        const shape = dispatcherResponseShape(response.tool_calls ?? [], response.content);
        await input.eventSink?.({
          type: "bus_dispatcher_protocol_retry_scheduled",
          session_id: input.sessionId,
          workflow_id: input.workflowId,
          routing_id: routingId,
          retry_attempt: 1,
          reason: retryReason,
          response_shape: shape
        });
        correction = {
          role: "user",
          metadata: { userMessageKind: "runtime_context", durableRuntimeContext: true },
          content: valid
            ? "Re-evaluate autonomously. Use exactly one decision tool. Ask the user only if a material decision cannot be inferred from context."
            : "Your previous response violated the bus decision protocol. Return exactly one phase-appropriate decision using the required tool or schema."
        };
        continue;
      }
      if (lowConfidenceFallback) {
        return failedSelection(
          `Dispatcher confidence remained below threshold after retry: ${lowConfidenceFallback.confidence}`,
          input.phase,
          routingId,
          "protocol",
          fallbackThinking
        );
      }
      return invalidSelection(
        "Dispatcher response did not contain one valid directive after protocol retry",
        input.phase,
        routingId,
        response.thinking,
        dispatcherResponseShape(response.tool_calls ?? [], response.content)
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      if (lowConfidenceFallback) {
        return failedSelection(
          `Dispatcher confidence remained below threshold after retry: ${lowConfidenceFallback.confidence}`,
          input.phase,
          routingId,
          "protocol",
          fallbackThinking
        );
      }
      return failedSelection(error, input.phase, routingId, "provider");
    }
  }
  return invalidSelection("Dispatcher exhausted protocol attempts", input.phase, routingId);
}

function dispatcherMessages(input: DispatcherRequest, workflow: WorkflowConfig): ModelMessage[] {
  const executionKind = input.executionKind ?? "workflow";
  const nodeCatalog = workflow.nodes.map((node, index) => ({
    position: index,
    id: node.id,
    role: node.role,
    role_description: input.config.roles[node.role]?.description ?? ""
  }));
  const phaseRules = input.phase === "plan"
    ? "The user is in Plan Mode. Select the best eventual execution node with SelectWorkflowNode, or use RequestClarification only for a material user decision that cannot be inferred."
    : input.phase === "lifecycle"
      ? `The ${executionKind} is at a bus boundary. Read the full dossier, then use DispatchWorkflowNode, RequestClarification, or FinalizeTask.`
      : "Route the user message autonomously with AnswerDirectly, DispatchWorkflowNode, or RequestClarification. Never enter Plan Mode or finalize the task.";
  const busPrompt = [
    "You are the session execution bus. The user communicates only with you.",
    executionKind === "team"
      ? "You own all team-member routing. Members are unordered and never select the next member; after every member result you must dynamically dispatch a member, clarify, or finalize."
      : "You own workflow routing, lifecycle decisions, process-safe node reassignment, and the final task summary.",
    "Return exactly one phase-appropriate decision. Never emit ordinary assistant text outside the decision protocol.",
    "Never silently fall back to the first node. Every directive must include confidence from 0 to 1.",
    "Do not ask the user to choose a node or to choose between direct answer and delegation; that routing decision belongs to you.",
    "Use RequestClarification only when a missing user decision materially changes the outcome and cannot be inferred from the conversation or repository evidence.",
    "SelectWorkflowNode is available only when the user explicitly enabled Plan Mode.",
    "Use DispatchWorkflowNode to start or reassign execution at an explicit node.",
    "Use FinalizeTask only at a lifecycle boundary when every latest result has fresh verified runtime evidence. Never treat model confidence as execution evidence.",
    "When the user forbids deletion or destructive changes, set destructive_policy to deny; otherwise set it to ask.",
    phaseRules,
    `Execution target: ${executionKind} ${input.workflowId}`,
    `Nodes: ${JSON.stringify(nodeCatalog)}`
  ].join("\n");
  const system = [
    input.config.global_prompt?.trim(),
    input.config.roles.bus?.system_prompt.trim(),
    busPrompt
  ].filter(Boolean).join("\n\n");
  const runtimeContextMessage: ModelMessage[] = input.runtimeContext
    ? [{
        role: "user",
        metadata: { userMessageKind: "runtime_context", durableRuntimeContext: true },
        content: JSON.stringify({ type: "session_execution_context", context: input.runtimeContext })
      }]
    : [];
  const dossierMessage: ModelMessage[] = input.dossier
    ? [{
        role: "user",
        metadata: { userMessageKind: "runtime_context", durableRuntimeContext: true },
        content: JSON.stringify({ type: "workflow_run_dossier", dossier: compactWorkflowRunDossier(input.dossier) })
      }]
    : [];
  return [{ role: "system", content: system }, ...runtimeContextMessage, ...boundedBusMessages(input.messages), ...dossierMessage];
}

function boundedBusMessages(messages: ModelMessage[], limit = 20): ModelMessage[] {
  if (messages.length <= limit) return messages;
  const durable = messages.filter((message) => message.metadata?.durableRuntimeContext === true).slice(-4);
  const recent = messages.slice(-limit);
  return [...new Set([...durable, ...recent])];
}

function parseDispatcherResponse(toolCalls: Array<{ id: string; name: string; input: unknown }>, content: string | undefined): DispatchDirective | undefined {
  if (toolCalls.length) {
    if (toolCalls.length !== 1) return undefined;
    const call = toolCalls[0]!;
    if (call.name === "AnswerDirectly") {
      const value = answerToolInputSchema.safeParse(call.input);
      return value.success ? { type: "answer", ...value.data } : undefined;
    }
    if (call.name === "RequestClarification") {
      const value = clarifyToolInputSchema.safeParse(call.input);
      return value.success ? { type: "clarify", ...value.data } : undefined;
    }
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

function dispatcherTools(phase: DispatcherPhase): Tool[] {
  const answerDirectly = directiveTool(
    "AnswerDirectly",
    "Answer the user directly when delegation adds no value.",
    messageDirectiveSchema()
  );
  const requestClarification = directiveTool(
    "RequestClarification",
    "Ask only for a material user decision that cannot be inferred from available context.",
    messageDirectiveSchema()
  );
  const selectNode = directiveTool(
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
    );
  const dispatchNode = directiveTool(
      "DispatchWorkflowNode",
      "Start or reassign workflow execution at an explicit node.",
      {
        type: "object",
        additionalProperties: false,
        properties: {
          node_id: { type: "string" },
          instruction: { type: "string" },
          reason: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          destructive_policy: { type: "string", enum: ["ask", "deny"] }
        },
        required: ["node_id", "instruction", "reason", "confidence"]
      }
    );
  const finalizeTask = directiveTool(
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
    );
  if (phase === "plan") return [selectNode, requestClarification];
  if (phase === "lifecycle") return [dispatchNode, requestClarification, finalizeTask];
  return [answerDirectly, requestClarification, dispatchNode];
}

function directiveAllowedForPhase(directive: DispatchDirective, phase: DispatcherPhase): boolean {
  if (directive.type === "routing_failed") return false;
  if (phase === "plan") return directive.type === "plan" || directive.type === "clarify";
  if (phase === "lifecycle") return directive.type === "dispatch" || directive.type === "finalize" || directive.type === "clarify";
  return directive.type === "answer" || directive.type === "clarify" || directive.type === "dispatch";
}

function messageDirectiveSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      message: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    },
    required: ["message", "confidence"]
  };
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

function invalidSelection(
  detail: string,
  phase: DispatcherPhase,
  routingId: string,
  thinking?: string,
  responseShape?: string
): DispatcherSelection {
  return failedSelection(detail, phase, routingId, "protocol", thinking, responseShape);
}

function failedSelection(
  error: unknown,
  phase: DispatcherPhase,
  routingId: string,
  errorKind: "protocol" | "provider" | "configuration",
  thinking?: string,
  responseShape?: string
): DispatcherSelection {
  const detail = error instanceof Error ? error.message : String(error);
  const message = errorKind === "protocol"
    ? "调度模型连续两次未返回合法决策。请重试本次请求。"
    : errorKind === "configuration"
      ? `调度配置无效：${detail}`
      : `调度服务暂时不可用：${detail}`;
  return {
    directive: {
      type: "routing_failed",
      confidence: 0,
      message,
      error_kind: errorKind
    },
    routingId,
    phase,
    ...(thinking ? { thinking } : {}),
    ...(responseShape ? { responseShape } : {})
  };
}

function directiveTargetsKnownNode(directive: DispatchDirective, workflow: WorkflowConfig): boolean {
  if (directive.type !== "plan" && directive.type !== "dispatch") return true;
  return workflow.nodes.some((node) => node.id === directive.node_id);
}

function dispatcherResponseShape(
  toolCalls: Array<{ name: string; input: unknown }>,
  content: string | undefined
): string {
  if (toolCalls.length) return `tools:${toolCalls.map((call) => call.name || "<unnamed>").join(",")};count=${toolCalls.length}`;
  if (!content?.trim()) return "empty";
  const trimmed = content.trim();
  return `text:length=${trimmed.length};json=${trimmed.startsWith("{") && trimmed.endsWith("}")}`;
}

async function emitRetry(input: DispatcherRequest, retry: ModelRetryEvent, routingId: string): Promise<void> {
  await input.eventSink?.({
    type: "bus_dispatcher_retry_scheduled",
    session_id: input.sessionId,
    workflow_id: input.workflowId,
    routing_id: routingId,
    retry_attempt: retry.retryAttempt,
    max_retries: retry.maxRetries,
    retry_in_ms: retry.retryInMs,
    error: retry.message,
    discarded_thinking_chars: retry.discardedThinkingChars
  });
}

function dispatcherDirectiveJsonSchema(phase: DispatcherPhase) {
  const directiveTypes = phase === "plan"
    ? ["plan", "clarify"]
    : phase === "lifecycle"
      ? ["dispatch", "finalize", "clarify"]
      : ["answer", "clarify", "dispatch"];
  return {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: directiveTypes },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    message: { type: "string" },
    node_id: { type: "string" },
    reason: { type: "string" },
    instruction: { type: "string" },
    destructive_policy: { type: "string", enum: ["ask", "deny"] },
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
}

export function renderTaskSummary(summary: TaskSummary): string {
  const sections = [summary.summary.trim()];
  if (summary.outcomes.length) sections.push(["## Outcomes", ...summary.outcomes.map((item) => `- ${item}`)].join("\n"));
  if (summary.verification.length) sections.push(["## Verification", ...summary.verification.map((item) => `- ${item}`)].join("\n"));
  if (summary.residual_risks.length) sections.push(["## Residual risks", ...summary.residual_risks.map((item) => `- ${item}`)].join("\n"));
  if (summary.artifacts.length) sections.push(["## Artifacts", ...summary.artifacts.map((item) => `- ${item}`)].join("\n"));
  return sections.filter(Boolean).join("\n\n");
}
