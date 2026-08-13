import { createHash, randomUUID } from "node:crypto";
import type { ExecutionKind, PermissionSet, WorkflowNodeConfig } from "../config/schema.js";
import { ModelMessage, ModelProvider, ModelResponse, ModelRetryEvent, ModelToolCall } from "../providers/types.js";
import { getModelContextLimits, type ModelRegistry } from "../model/modelRegistry.js";
import {
  buildCompactedDialogue,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  compactSummaryMessage,
  compactSummaryPrompt,
  dropOldestCompactionItem,
  formatCompactSummary,
  isContextLimitError,
  isDurableRuntimeContext
} from "../model/contextCompaction.js";
import { skillActivationFromToolResult, skillPermissionRulesFromToolResult, skillRuntimeOverridesFromToolResult, skillSystemMessageFromToolResult } from "../skills/skillTools.js";
import { hasModelUsage } from "../model/usage.js";
import { contextTokensFromUsage, estimateModelMessageTokens, estimateModelMessagesTokens } from "../model/contextUsage.js";
import { prepareMcpDiscovery, mergePreCompactDiscoveredTools, withMcpCatalogMessage } from "../mcp/discovery.js";
import { isUntrustedToolResultSource } from "../mcp/runtime.js";
import { isToolExplicitlyDenied } from "./permissions.js";
import { executeTool, toolFailureInfo, toolFailureResult, toolPolicyFailureResult } from "../tools/errors.js";
import { isShellToolName, shellCallMatchesFailureCategory } from "../tools/local/shellPolicy.js";
import { modelToolResultContent, toolResultMessage } from "../tools/modelResult.js";
import { ToolRegistry } from "../tools/registry.js";
import { Tool, ToolResult } from "../tools/types.js";
import { RunStore } from "../storage/runStore.js";
import { buildNodeMessages } from "./context.js";
import { NodeResult, nodeResultJsonSchema, nodeResultSchema, parseNodeResult, visibleAssistantTextBeforeNodeResult } from "../team/nodeResult.js";
import { PermissionDecision, PermissionRequest } from "./permissionController.js";
import { HarnessEvent, StoredEvent } from "./events.js";
import { TurnEngine } from "../runtime/turnEngine.js";
import { formatRunErrorText } from "../runtime/errorFormatting.js";
import type { ToolPermissionContext } from "../permissions/context.js";
import { checkToolPermission } from "../permissions/checkToolPermission.js";
import type { NodeNavigation } from "../workflow/nodeTransitionController.js";
import { isHumanUserMessage } from "../context/messages.js";
import type { PendingTurnInput } from "../runtime/activeTurnInput.js";

const maxCompactionRetries = 20;
export type RuntimeInteraction = {
  requestPermission?(request: PermissionRequest): Promise<PermissionDecision>;
};
export type NodeRuntimeOptions = {
  node: WorkflowNodeConfig;
  systemPrompt: string;
  model: string;
  effort?: string | number;
  provider: ModelProvider;
  tools: ToolRegistry;
  permissions: ToolPermissionContext | PermissionSet;
  cwd: string;
  runId: string;
  store: RunStore;
  handoff: unknown;
  navigation?: NodeNavigation;
  executionKind?: ExecutionKind;
  attempt?: number;
  activation?: number;
  dialogueMessages?: ModelMessage[];
  dialogueCursor?: number;
  modelRegistry?: ModelRegistry;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  onDialogueMessage?: (message: ModelMessage) => Promise<number | void> | number | void;
  onDialogueMessages?: (messages: ModelMessage[]) => Promise<void> | void;
  onDialogueCompacted?: (messages: ModelMessage[], cursor: number) => Promise<void> | void;
  interaction?: RuntimeInteraction;
  eventSink?: (event: StoredEvent) => void;
  drainPendingUserInputs?: () => PendingTurnInput<ModelMessage>[];
  onUserInputRequested?: (request: NodeWaitingUserResult) => void | Promise<void>;
  abortSignal?: AbortSignal;
};

export type NodeWaitingUserResult = {
  status: "waiting_user";
  toolCallId: string;
  questions: NodeResult["questions"];
};

export async function runNode(options: NodeRuntimeOptions): Promise<NodeResult> {
  options.abortSignal?.throwIfAborted();
  const attempt = options.attempt ?? 1;
  const activation = options.activation ?? 1;
  const artifactDeliverables: NodeResult["deliverables"] = [];
  const runtimePermissions = normalizeRuntimePermissions(options.permissions);
  let requestTools = modelVisibleWorkflowTools(options.tools, runtimePermissions);
  await restoreSkillPermissions(options, runtimePermissions, attempt);
  const baseMessages = await buildNodeMessages(options.node, options.systemPrompt, options.handoff, {
    tools: requestTools,
    permissionMode: runtimePermissions.mode,
    navigation: options.navigation,
    executionKind: options.executionKind,
    runDir: options.store.runDir(options.runId),
    supportsVision: options.supportsVision,
    onArtifactRead: async (chunk) => { await appendRuntimeEvent(options, {
      type: "artifact_read",
      node_id: options.node.id,
      attempt,
      artifact_id: chunk.artifact_id,
      offset: chunk.offset,
      bytes_read: Buffer.byteLength(chunk.content, "utf8"),
      total_bytes: chunk.total_bytes,
      truncated: chunk.truncated,
      source: "handoff"
    }); }
  });
  let activeDialogue = [...options.dialogueMessages ?? []];
  const durableDialogue = await options.store.loadWorkflowDialogueState(options.runId, options.node.id, attempt, undefined, activation);
  const restoredDurableTail = options.dialogueCursor !== undefined && durableDialogue.cursor > options.dialogueCursor;
  if (restoredDurableTail) activeDialogue = durableDialogue.messages;
  const messages: ModelMessage[] = [...baseMessages, ...activeDialogue];
  const baseMessageCount = baseMessages.length;
  const dialogueMessageCount = () => messages.length - baseMessageCount;
  let dialogueCursor = await options.store.syncWorkflowDialogue(options.runId, options.node.id, attempt, activeDialogue, activation);
  let dialogueWindow = durableDialogue.window;
  const requestHistory = (dialogue = messages.slice(baseMessageCount)): ModelMessage[] => {
    if (dialogueWindow.windowNumber === 0) return [...baseMessages, ...dialogue];
    const systemMessages = baseMessages.filter((message) => message.role === "system");
    const canonicalContext = baseMessages.filter((message) => message.role !== "system");
    let insertionIndex = -1;
    for (let index = dialogue.length - 1; index >= 0; index -= 1) {
      if (isHumanUserMessage(dialogue[index]!)) {
        insertionIndex = index;
        break;
      }
    }
    if (insertionIndex < 0) {
      for (let index = dialogue.length - 1; index >= 0; index -= 1) {
        if (isDurableRuntimeContext(dialogue[index]!)) {
          insertionIndex = index;
          break;
        }
      }
    }
    if (insertionIndex < 0) {
      for (let index = dialogue.length - 1; index >= 0; index -= 1) {
        if (dialogue[index]?.metadata?.compactSummary === true) {
          insertionIndex = index;
          break;
        }
      }
    }
    if (insertionIndex < 0) insertionIndex = dialogue.length;
    return [
      ...systemMessages,
      ...dialogue.slice(0, insertionIndex),
      ...canonicalContext,
      ...dialogue.slice(insertionIndex)
    ];
  };
  if (restoredDurableTail) {
    await options.onDialogueCompacted?.([...activeDialogue], dialogueCursor);
    await options.onDialogueMessages?.([...activeDialogue]);
  }
  const currentLimits = () => getModelContextLimits(options.model, options.modelRegistry, options.maxOutputTokens);
  const previousContext = await options.store.latestNodeContext(options.runId, options.node.id, attempt, activation);
  let contextTokens = previousContext && previousContext.dialogue_message_count <= dialogueMessageCount()
    ? previousContext.context_tokens
    : estimateModelMessagesTokens(messages);
  let prefixInputTokens = previousContext?.prefix_input_tokens ?? dialogueWindow.prefixInputTokens;
  let samplingInputOverheadTokens = 0;
  const scopedContextTokens = () => {
    const limits = currentLimits();
    return limits.autoCompactTokenLimitScope === "body_after_prefix"
      ? Math.max(0, contextTokens - (prefixInputTokens ?? 0))
      : contextTokens;
  };
  const reachesCompactLimit = () => {
    const limits = currentLimits();
    return contextTokens >= limits.effectiveContextWindow || scopedContextTokens() >= limits.autoCompactLimit;
  };
  const publishContext = async () => {
    const limits = currentLimits();
    await appendRuntimeEvent(options, {
      type: "node_context_updated",
      node_id: options.node.id,
      attempt,
      activation: options.activation,
      model: options.model,
      compaction_hash: limits.compactionHash,
      context_window: limits.effectiveContextWindow,
      context_tokens: contextTokens,
      context_limit: limits.autoCompactLimit,
      prefix_input_tokens: prefixInputTokens,
      window_number: dialogueWindow.windowNumber,
      current_window_id: dialogueWindow.currentWindowId,
      dialogue_message_count: dialogueMessageCount(),
      dialogue_cursor: dialogueCursor
    });
  };
  if (previousContext) {
    const hasNewDialogue = previousContext.dialogue_message_count < dialogueMessageCount();
    if (hasNewDialogue) {
      contextTokens += estimateModelMessagesTokens(messages.slice(baseMessageCount + previousContext.dialogue_message_count));
    }
    if (hasNewDialogue || (previousContext.activation ?? 1) !== (options.activation ?? 1)) await publishContext();
  } else {
    await publishContext();
  }

  const turnEngine = new TurnEngine();
  let resultRepairAttempts = 0;
  let emptyResponseRepairAttempts = 0;
  let toolPreambleRepairAttempts = 0;
  const toolFailureCounts = new Map<string, { category: string; count: number }>();
  let hasSampledModel = false;
  let lastSampledModel = previousContext?.model ?? dialogueWindow.model ?? options.model;
  const replaceDialogue = async (activeDialogue: ModelMessage[], cursor: number) => {
    messages.splice(baseMessageCount, messages.length - baseMessageCount, ...activeDialogue);
    dialogueCursor = cursor;
    await options.onDialogueCompacted?.([...activeDialogue], cursor);
    await options.onDialogueMessages?.([...activeDialogue]);
  };
  const appendDialogueMessage = async (message: ModelMessage, includedInLatestResponse = false) => {
    messages.push(message);
    const persistedCursor = await options.onDialogueMessage?.(message);
    dialogueCursor = typeof persistedCursor === "number" ? persistedCursor : dialogueCursor + 1;
    await options.onDialogueMessages?.(messages.slice(baseMessageCount));
    if (!includedInLatestResponse) contextTokens += estimateModelMessageTokens(message);
    await publishContext();
  };
  const injectPendingUserInputs = async (pendingInputs: PendingTurnInput<ModelMessage>[]) => {
    for (const pending of pendingInputs) {
      await appendDialogueMessage(pending.input);
      const content = pending.input.content;
      const text = typeof content === "string"
        ? content
        : content.filter((part) => part.type === "text").map((part) => part.type === "text" ? part.text : "").join("\n");
      await appendRuntimeEvent(options, {
        type: "user_input_injected",
        input_id: pending.id,
        text: text || "See attached image.",
        node_id: options.node.id,
        attempt,
        activation: options.activation
      });
    }
  };
  const recordToolFailure = async (call: ModelToolCall, failure: ToolResult, countFailure = true) => {
    const message = failure.error ?? "Tool failed";
    const info = toolFailureInfo(failure);
    if (info && countFailure) {
      const current = toolFailureCounts.get(info.fingerprint);
      toolFailureCounts.set(info.fingerprint, {
        category: info.category,
        count: (current?.count ?? 0) + 1
      });
    }
    await appendRuntimeEvent(options, {
      type: "tool_failed",
      node_id: options.node.id,
      attempt,
      activation: options.activation,
      tool_call_id: call.id,
      tool: call.name,
      error: message,
      result: failure,
      ...(info ? { failure_category: info.category, failure_fingerprint: info.fingerprint } : {})
    });
    await appendDialogueMessage({
      role: "tool",
      tool_call_id: call.id,
      is_error: true,
      content: JSON.stringify(failure)
    });
  };
  const performLocalCompaction = async (
    phase: "pre_turn" | "mid_turn",
    reason: "threshold" | "model_change" | "smaller_context",
    compactionModel: string,
    dialogueToSummarize = messages.slice(baseMessageCount),
    pendingMessages: ModelMessage[] = []
  ): Promise<void> => {
    const limits = getModelContextLimits(compactionModel, options.modelRegistry, options.maxOutputTokens);
    const contextBefore = contextTokens;
    const scopedCompactionLimit = limits.autoCompactTokenLimitScope === "body_after_prefix"
      ? limits.autoCompactLimit + (prefixInputTokens ?? 0)
      : limits.autoCompactLimit;
    const safeContextLimit = Math.max(
      1,
      Math.min(limits.effectiveContextWindow, scopedCompactionLimit) - limits.maxOutputTokens
    );
    const immutableContextTokens = estimateModelMessagesTokens(requestHistory([])) + samplingInputOverheadTokens;
    await appendRuntimeEvent(options, {
      type: "node_context_compaction_started",
      node_id: options.node.id,
      attempt,
      activation: options.activation,
      trigger: "auto",
      phase,
      reason,
      implementation: "local",
      model: compactionModel,
      context_tokens: contextBefore,
      context_limit: limits.autoCompactLimit,
      window_number: dialogueWindow.windowNumber,
      current_window_id: dialogueWindow.currentWindowId
    });

    try {
      if (immutableContextTokens >= safeContextLimit) {
        throw new Error(
          `Context compaction cannot create safe headroom: immutable context ${immutableContextTokens} tokens, safe limit ${safeContextLimit} tokens`
        );
      }
      const originalDialogue = [...dialogueToSummarize];
      let truncatedMessageCount = 0;
      let summaryResponse: ModelResponse | undefined;
      // dropOldestCompactionItem removes one or two messages per pass, so an unbounded loop can
      // fire hundreds of billed requests against a dialogue that will never fit.
      for (let retry = 0; retry < maxCompactionRetries; retry += 1) {
        options.abortSignal?.throwIfAborted();
        try {
          ({ response: summaryResponse } = await turnEngine.requestModel({
            provider: options.provider,
            request: {
              model: compactionModel,
              effort: options.effort,
              maxOutputTokens: limits.maxOutputTokens,
              messages: [
                ...requestHistory(dialogueToSummarize),
                { role: "user", content: limits.compactPrompt ?? compactSummaryPrompt(), metadata: { userMessageKind: "compaction" } }
              ],
              tools: [],
              signal: options.abortSignal,
              context: {
                runId: options.runId,
                nodeId: options.node.id,
                attempt,
                sessionId: options.runId,
                threadId: `${options.runId}:${options.node.id}`,
                turnId: `${options.runId}:${options.node.id}:${attempt}:compact:${phase}:${retry + 1}`,
                promptCacheKey: promptCacheKey(options.runId, options.node.id)
              },
              onRetry: async (retry) => {
                await appendRuntimeEvent(options, modelRetryHarnessEvent(options, attempt, "compaction", retry));
              }
            }
          }));
          break;
        } catch (error) {
          if (!isContextLimitError(error)) throw error;
          const truncated = dropOldestCompactionItem(dialogueToSummarize);
          if (!truncated) throw error;
          truncatedMessageCount += Math.max(0, dialogueToSummarize.length - truncated.length);
          dialogueToSummarize = truncated;
        }
      }

      if (!summaryResponse) throw new Error("Context compaction returned no response");
      await appendRuntimeEvent(options, {
        type: "model_response_recorded",
        node_id: options.node.id,
        attempt,
        activation: options.activation,
        model: compactionModel,
        usage: summaryResponse.usage,
        stop_reason: summaryResponse.stopReason
      });
      await appendModelUsageEvent(options, attempt, compactionModel, summaryResponse);
      if (summaryResponse.tool_calls?.length) throw new Error("Context compaction attempted to call tools");
      const summary = formatCompactSummary(summaryResponse.content ?? "");
      if (!summary) throw new Error("Context compaction returned an empty summary");

      const summaryMessage = mergePreCompactDiscoveredTools(compactSummaryMessage(summary), messages);
      const retainedUserBudget = Math.min(
        COMPACT_USER_MESSAGE_MAX_TOKENS,
        Math.max(
          0,
          safeContextLimit
            - immutableContextTokens
            - estimateModelMessageTokens(summaryMessage)
            - estimateModelMessagesTokens(pendingMessages)
            - 1
        )
      );
      const replacementHistory = [
        ...buildCompactedDialogue(originalDialogue, summaryMessage, retainedUserBudget),
        ...pendingMessages
      ];
      const compactedContextTokens = immutableContextTokens + estimateModelMessagesTokens(replacementHistory);
      if (compactedContextTokens >= safeContextLimit) {
        throw new Error(
          `Context compaction did not create safe headroom: compacted context ${compactedContextTokens} tokens, safe limit ${safeContextLimit} tokens`
        );
      }
      const compactedState = await options.store.compactWorkflowDialogue(options.runId, options.node.id, attempt, {
        replacementHistory,
        phase,
        reason,
        model: compactionModel,
        compactionHash: limits.compactionHash,
        contextWindow: limits.effectiveContextWindow,
        prefixInputTokens
      }, activation);
      await replaceDialogue(compactedState.messages, compactedState.cursor);
      dialogueWindow = compactedState.window;
      contextTokens = compactedContextTokens;
      prefixInputTokens = undefined;
      await appendRuntimeEvent(options, {
        type: "node_context_compacted",
        node_id: options.node.id,
        attempt,
        activation: options.activation,
        trigger: "auto",
        phase,
        reason,
        implementation: "local",
        model: compactionModel,
        context_tokens_before: contextBefore,
        context_tokens_after: contextTokens,
        context_limit: limits.autoCompactLimit,
        dialogue_cursor: dialogueCursor,
        retained_user_message_count: replacementHistory.filter(isHumanUserMessage).length,
        retained_runtime_context_count: replacementHistory.filter(isDurableRuntimeContext).length,
        window_number: dialogueWindow.windowNumber,
        first_window_id: dialogueWindow.firstWindowId,
        previous_window_id: dialogueWindow.previousWindowId!,
        current_window_id: dialogueWindow.currentWindowId,
        ...(truncatedMessageCount ? { truncated_message_count: truncatedMessageCount } : {})
      });
      await publishContext();
    } catch (error) {
      if (options.abortSignal?.aborted || isAbortLikeError(error)) throw error;
      await appendRuntimeEvent(options, {
        type: "node_context_compaction_failed",
        node_id: options.node.id,
        attempt,
        activation: options.activation,
        trigger: "auto",
        phase,
        reason,
        implementation: "local",
        model: compactionModel,
        error: errorMessage(error)
      });
      throw error;
    }
  };
  const recoveredMessages = await reconcileInterruptedToolCalls(options, attempt, messages, artifactDeliverables);
  if (recoveredMessages.length) {
    const reconciledState = await options.store.reconcileWorkflowDialogue(
      options.runId,
      options.node.id,
      attempt,
      messages.slice(baseMessageCount),
      recoveredMessages,
      activation
    );
    await replaceDialogue(reconciledState.messages, reconciledState.cursor);
    contextTokens += estimateModelMessagesTokens(recoveredMessages);
    await publishContext();
  }

  const previousDialogueCount = previousContext
    ? Math.min(previousContext.dialogue_message_count, dialogueMessageCount())
    : dialogueMessageCount();
  const preTurnDialogue = messages.slice(baseMessageCount, baseMessageCount + previousDialogueCount);
  const pendingPreTurnMessages = messages.slice(baseMessageCount + previousDialogueCount);
  const previousModel = previousContext?.model ?? dialogueWindow.model;
  let preTurnReason: "threshold" | "model_change" | "smaller_context" | undefined;
  let preTurnModel = options.model;
  if (previousModel && previousModel !== options.model) {
    const previousLimits = getModelContextLimits(previousModel, options.modelRegistry, options.maxOutputTokens);
    const nextLimits = currentLimits();
    if (previousLimits.compactionHash && nextLimits.compactionHash && previousLimits.compactionHash !== nextLimits.compactionHash) {
      preTurnReason = "model_change";
      preTurnModel = previousModel;
    } else if (previousLimits.effectiveContextWindow > nextLimits.effectiveContextWindow && contextTokens >= nextLimits.autoCompactLimit) {
      preTurnReason = "smaller_context";
      preTurnModel = previousModel;
    }
  }
  if (!preTurnReason && reachesCompactLimit()) preTurnReason = "threshold";
  if (preTurnReason) {
    await performLocalCompaction("pre_turn", preTurnReason, preTurnModel, preTurnDialogue, pendingPreTurnMessages);
  }

  return await turnEngine.runLoop<NodeResult | NodeWaitingUserResult>({
    runIteration: async () => {
    options.abortSignal?.throwIfAborted();
    if (hasSampledModel) {
      const sampledLimits = getModelContextLimits(lastSampledModel, options.modelRegistry, options.maxOutputTokens);
      const nextLimits = currentLimits();
      let reason: "threshold" | "model_change" | "smaller_context" | undefined;
      if (lastSampledModel !== options.model && sampledLimits.compactionHash && nextLimits.compactionHash && sampledLimits.compactionHash !== nextLimits.compactionHash) {
        reason = "model_change";
      } else if (lastSampledModel !== options.model && sampledLimits.effectiveContextWindow > nextLimits.effectiveContextWindow && contextTokens >= nextLimits.autoCompactLimit) {
        reason = "smaller_context";
      } else if (reachesCompactLimit()) {
        reason = "threshold";
      }
      if (reason) await performLocalCompaction("mid_turn", reason, lastSampledModel);
      hasSampledModel = false;
    }

    while (true) {
      const pendingInputs = options.drainPendingUserInputs?.() ?? [];
      if (!pendingInputs.length) break;
      await injectPendingUserInputs(pendingInputs);
    }
    assertResolvedToolCallHistory(messages);
    const discovery = options.tools.mcpRuntime
      ? prepareMcpDiscovery({
        runtime: options.tools.mcpRuntime,
        registry: options.tools,
        messages,
        permissions: runtimePermissions
      })
      : undefined;
    requestTools = modelVisibleWorkflowTools(options.tools, runtimePermissions);
    if (discovery) {
      await appendRuntimeEvent(options, {
        type: "mcp_catalog_published",
        node_id: options.node.id,
        attempt,
        activation: options.activation,
        revision: discovery.revision,
        protocol: options.provider.deferredToolProtocol?.(options.model) ?? "portable",
        deferred_tools: discovery.deferredToolNames,
        discovered_tools: discovery.discoveredToolNames,
        pending_servers: discovery.pendingServers,
        failed_servers: discovery.failedServers.map((server) => server.name)
      });
    }
    const streamBatcher = new RuntimeStreamBatcher(options, attempt);
    const request = {
      model: options.model,
      effort: options.effort,
      maxOutputTokens: currentLimits().maxOutputTokens,
      messages: discovery ? withMcpCatalogMessage(requestHistory(), discovery) : requestHistory(),
      tools: requestTools,
      ...(discovery?.deferredToolNames.length ? { deferredToolNames: discovery.deferredToolNames, deferredTools: discovery.deferredTools } : {}),
      response_schema: requestTools.length ? undefined : nodeResultJsonSchema,
      signal: options.abortSignal,
      context: {
        runId: options.runId,
        nodeId: options.node.id,
        attempt,
        sessionId: options.runId,
        threadId: `${options.runId}:${options.node.id}`,
        turnId: `${options.runId}:${options.node.id}:${attempt}`,
        promptCacheKey: promptCacheKey(options.runId, options.node.id)
      },
      onRetry: async (retry: ModelRetryEvent) => {
        await streamBatcher.drain();
        await appendRuntimeEvent(options, modelRetryHarnessEvent(options, attempt, "sampling", retry));
      }
    };
    let streamed: boolean;
    let response: ModelResponse;
    try {
      ({ streamed, response } = await turnEngine.requestModel({
        provider: options.provider,
        request,
        onStreamEvent(event) {
          streamBatcher.push(event.type === "thinking_delta" ? "thinking" : "content", event.text);
        }
      }));
    } catch (error) {
      await streamBatcher.drain();
      if (options.abortSignal?.aborted || isAbortLikeError(error)) throw error;
      if (isContextLimitError(error)) {
        contextTokens = currentLimits().effectiveContextWindow;
        await publishContext();
      }
      await appendDialogueMessage({ role: "assistant", content: formatRunErrorText(error), is_error: true });
      throw error;
    }
    await appendRuntimeEvent(options, {
      type: "model_response_recorded",
      node_id: options.node.id,
      attempt,
      activation: options.activation,
      model: options.model,
      usage: response.usage,
      stop_reason: response.stopReason
    });
    await appendModelUsageEvent(options, attempt, options.model, response);
    const responseContextTokens = contextTokensFromUsage(response.usage);
    const responseIncludedInUsage = responseContextTokens !== undefined;
    if (response.usage?.inputTokens !== undefined) {
      samplingInputOverheadTokens = Math.max(
        0,
        response.usage.inputTokens - estimateModelMessagesTokens(request.messages)
      );
    }
    lastSampledModel = request.model;
    hasSampledModel = true;
    if (
      prefixInputTokens === undefined
      && currentLimits().autoCompactTokenLimitScope === "body_after_prefix"
      && response.usage?.inputTokens !== undefined
    ) {
      prefixInputTokens = Math.max(0, response.usage.inputTokens);
    }
    if (responseContextTokens !== undefined) {
      contextTokens = responseContextTokens;
      await publishContext();
    }
    await streamBatcher.drain();
    options.abortSignal?.throwIfAborted();
    if (!streamed) await appendNonStreamingResponseEvents(options, attempt, response);
    if (response.tool_calls?.length) {
      let pendingInputs = options.drainPendingUserInputs?.() ?? [];
      if (pendingInputs.length) {
        const assistantContent = assistantToolCallContent(response.content);
        if (assistantContent.trim()) {
          await appendDialogueMessage({ role: "assistant", content: assistantContent }, responseIncludedInUsage);
        }
        while (pendingInputs.length) {
          await injectPendingUserInputs(pendingInputs);
          pendingInputs = options.drainPendingUserInputs?.() ?? [];
        }
        return undefined;
      }
      const submittedResult = response.tool_calls.find((call) => call.name === submitNodeResultTool.name);
      if (submittedResult) {
        await appendDialogueMessage({ role: "assistant", content: assistantToolCallContent(response.content), tool_calls: [submittedResult] }, responseIncludedInUsage);
        await appendDialogueMessage(submitNodeResultToolMessage(submittedResult.id));
        const submittedNodeResult = mergeArtifactDeliverables(nodeResultSchema.parse(submittedResult.input), artifactDeliverables);
        let injectedInput = false;
        while (true) {
          const pendingInputs = options.drainPendingUserInputs?.() ?? [];
          if (!pendingInputs.length) break;
          injectedInput = true;
          await injectPendingUserInputs(pendingInputs);
        }
        return injectedInput ? undefined : submittedNodeResult;
      }
      const assistantContent = assistantToolCallContent(response.content);
      if (!assistantContent.trim() && shouldRepairToolPreamble(response.content) && toolPreambleRepairAttempts < 1) {
        toolPreambleRepairAttempts += 1;
        await appendDialogueMessage({ role: "user", content: toolPreambleRepairPrompt(response.content, response.tool_calls), metadata: { userMessageKind: "runtime_context" } });
        return undefined;
      }
      const interactionCall = await firstUserInteractionTool(response.tool_calls, options.tools);
      const executableToolCalls = interactionCall ? [interactionCall] : response.tool_calls;
      await appendDialogueMessage({ role: "assistant", content: assistantContent, tool_calls: executableToolCalls }, responseIncludedInUsage);
      let shellFailureInResponse: { tool: string; toolCallId: string; error: string } | undefined;
      for (const call of executableToolCalls) {
        options.abortSignal?.throwIfAborted();
        options.tools.activateSkillsForInput(call.input, options.cwd);
        const specifier = toolSpecifier(call.name, call.input);
        if (!options.tools.has(call.name)) {
          const failure: ToolResult = { is_error: true, error: `Unknown tool ${call.name}` };
          await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error: failure.error!, result: failure });
          await appendDialogueMessage({ role: "tool", tool_call_id: call.id, is_error: true, content: JSON.stringify(failure) });
          continue;
        }
        const tool = options.tools.get(call.name);
        if (shellFailureInResponse && tool.isReadOnly?.(call.input, {
          cwd: options.cwd,
          runDir: options.store.runDir(options.runId),
          nodeId: options.node.id,
          attempt,
          activation: options.activation ?? 1
        }) !== true) {
          const failure = toolPolicyFailureResult(
            "tool.cancelled_after_shell_failure",
            "Tool call cancelled because an earlier shell call in the same model response failed. Re-plan from the failure before performing more writes.",
            shellFailureInResponse.tool + ":" + shellFailureInResponse.toolCallId
          );
          await recordToolFailure(call, failure, false);
          continue;
        }
        const blockedFailure = blockedShellStrategyFailure(call, toolFailureCounts);
        if (blockedFailure) {
          await recordToolFailure(call, blockedFailure, false);
          shellFailureInResponse = {
            tool: call.name,
            toolCallId: call.id,
            error: blockedFailure.error ?? "Shell strategy blocked"
          };
          continue;
        }
        const permission = await checkToolPermission(tool, call.input, { ...runtimePermissions, cwd: options.cwd });
        if (permission.decision === "deny") {
          const error = `Permission denied for ${call.name}: ${permission.reason ?? permission.rule ?? "no rule"}`;
          if (!permission.rule) {
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error });
            throw new Error(error);
          }
          const failure: ToolResult = {
            is_error: true,
            error,
            data: { permission_denied: true, rule: permission.rule }
          };
          await recordToolFailure(call, failure, false);
          if (isShellToolName(call.name)) {
            shellFailureInResponse = { tool: call.name, toolCallId: call.id, error };
          }
          continue;
        }
        if (permission.decision === "ask") {
          if (!options.interaction?.requestPermission) {
            const error = `Permission ask is not interactive in this MVP for ${call.name}`;
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error });
            throw new Error(error);
          }
          const requestId = randomUUID();
          const request = {
            requestId,
            nodeId: options.node.id,
            attempt,
            toolCallId: call.id,
            tool: call.name,
            input: call.input,
            specifier,
            rule: permission.rule
          };
          await appendRuntimeEvent(options, {
            type: "permission_requested",
            request_id: requestId,
            node_id: options.node.id,
            attempt,
            tool_call_id: call.id,
            tool: call.name,
            input: call.input,
            rule: permission.rule,
            specifier
          });
          const decision = await options.interaction.requestPermission(request);
          await appendRuntimeEvent(options, {
            type: "permission_resolved",
            request_id: requestId,
            node_id: options.node.id,
            attempt,
            tool_call_id: call.id,
            decision
          });
          options.abortSignal?.throwIfAborted();
          if (decision === "deny_once") {
            const error = `Permission denied by user for ${call.name}`;
            await appendRuntimeEvent(options, { type: "tool_failed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, error });
            await appendDialogueMessage({ role: "tool", tool_call_id: call.id, is_error: true, content: JSON.stringify({ is_error: true, error }) });
            continue;
          }
        }
        options.abortSignal?.throwIfAborted();
        await assertToolCallCanExecute(options, attempt, call, tool);
        await appendRuntimeEvent(options, { type: "tool_invoked", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, input: call.input });
        try {
          const toolContext = { cwd: options.cwd, runDir: options.store.runDir(options.runId), nodeId: options.node.id, attempt, activation: options.activation ?? 1, runId: options.runId, provider: options.provider, model: options.model, toolRegistry: options.tools, toolPermissionContext: runtimePermissions, permissionMode: runtimePermissions.mode, planFilePath: runtimePermissions.planFilePath, abortSignal: options.abortSignal };
          const result = await executeTool(tool, call.input, toolContext);
          await appendRuntimeEvent(options, { type: "tool_completed", node_id: options.node.id, attempt, activation: options.activation, tool_call_id: call.id, tool: call.name, result });
          const artifact = artifactFromToolResult(result);
          if (artifact) {
            await appendRuntimeEvent(options, { type: "artifact_created", node_id: options.node.id, artifact_id: artifact.artifact_id, path: artifact.path });
            if (!artifactDeliverables.some((item) => item.artifact_id === artifact.artifact_id)) {
              artifactDeliverables.push({ artifact_id: artifact.artifact_id, description: artifact.description });
            }
          }
          const artifactRead = artifactReadFromToolResult(call.name, result);
          if (artifactRead) {
            await appendRuntimeEvent(options, { type: "artifact_read", node_id: options.node.id, attempt, source: "tool", ...artifactRead });
          }
          // A result relayed from an MCP server is untrusted data, not control flow: without this
          // gate a malicious server could forge a skill activation and grant itself Bash(*).
          const controlResult = isUntrustedToolResultSource(call.name) ? undefined : result;
          const skillActivation = skillActivationFromToolResult(controlResult);
          if (skillActivation) {
            applySkillPermissionRules(runtimePermissions, skillPermissionRulesFromToolResult(controlResult));
            await appendRuntimeEvent(options, {
              type: "skill_activated",
              node_id: options.node.id,
              attempt,
              activation: options.activation,
              name: skillActivation.name,
              mode: skillActivation.mode,
              source: skillActivation.source,
              version: skillActivation.version,
              allowed_tools: skillActivation.allowedTools
            });
          }
          const resultMessage = toolResultMessage(call.id, result, tool, toolContext, {
            tokenLimit: currentLimits().toolOutputTokenLimit
          });
          await appendDialogueMessage(resultMessage);
          const userInput = userInputFromToolResult(controlResult);
          if (userInput) {
            const waitingResult = { status: "waiting_user" as const, toolCallId: call.id, questions: userInput.questions };
            await options.onUserInputRequested?.(waitingResult);
            return waitingResult;
          }
          const discoveredTools = resultMessage.metadata?.mcpDiscovery?.discoveredTools ?? [];
          if (discoveredTools.length) {
            await appendRuntimeEvent(options, {
              type: "mcp_tools_discovered",
              node_id: options.node.id,
              attempt,
              activation: options.activation,
              query: typeof (call.input as { query?: unknown })?.query === "string" ? String((call.input as { query: string }).query) : "",
              tools: discoveredTools
            });
          }
          const skillMessage = skillSystemMessageFromToolResult(controlResult);
          if (skillMessage) await appendDialogueMessage(skillMessage);
          const skillOverrides = skillRuntimeOverridesFromToolResult(controlResult);
          const previousModel = options.model;
          if (skillOverrides?.model) options.model = skillOverrides.model;
          if (skillOverrides?.effort !== undefined) options.effort = skillOverrides.effort;
          if (options.model !== previousModel) await publishContext();
        } catch (error) {
          options.abortSignal?.throwIfAborted();
          const failure = toolFailureResult(error);
          await recordToolFailure(call, failure);
          if (isShellToolName(call.name)) {
            shellFailureInResponse = {
              tool: call.name,
              toolCallId: call.id,
              error: failure.error ?? "Shell command failed"
            };
          }
        }
      }
      return undefined;
    }
    if (!response.content?.trim()) {
      if (emptyResponseRepairAttempts >= 1) {
        throw new Error(`Node ${options.node.id} returned no content and no tool calls after repair attempt`);
      }
      emptyResponseRepairAttempts += 1;
      await appendDialogueMessage({
        role: "user",
        content: emptyResponseRepairPrompt(),
        metadata: { userMessageKind: "runtime_context" }
      });
      return undefined;
    }
    try {
      const result = mergeArtifactDeliverables(parseNodeResult(response.content), artifactDeliverables);
      await appendDialogueMessage({ role: "assistant", content: response.content }, responseIncludedInUsage);
      let injectedInput = false;
      while (true) {
        const pendingInputs = options.drainPendingUserInputs?.() ?? [];
        if (!pendingInputs.length) break;
        injectedInput = true;
        await injectPendingUserInputs(pendingInputs);
      }
      return injectedInput ? undefined : result;
    } catch (error) {
      if (resultRepairAttempts >= 1) throw new Error(`Invalid NodeResult after repair attempt: ${errorMessage(error)}`, { cause: error });
      resultRepairAttempts += 1;
      await appendDialogueMessage({ role: "assistant", content: response.content }, responseIncludedInUsage);
      await appendDialogueMessage({ role: "user", content: nodeResultRepairPrompt(error), metadata: { userMessageKind: "runtime_context" } });
      return undefined;
    }
    }
  }) as NodeResult;
}

const submitNodeResultTool: Tool = {
  name: "SubmitNodeResult",
  description: "Submit the final NodeResult and explicitly move forward, backward, or retry the current node.",
  input_schema: nodeResultJsonSchema as unknown as Record<string, unknown>,
  async execute() {
    return { error: "SubmitNodeResult is handled by the runtime", exit_code: 1 };
  }
};
const submittedNodeResultContent = JSON.stringify({ status: "submitted" });

function submitNodeResultToolMessage(toolCallId: string): ModelMessage {
  return { role: "tool", tool_call_id: toolCallId, content: submittedNodeResultContent };
}

function artifactFromToolResult(result: ToolResult): { artifact_id: string; path: string; description: string } | undefined {
  if (!result.artifact_id || !result.path) return undefined;
  return { artifact_id: result.artifact_id, path: result.path, description: result.description ?? "" };
}
function modelVisibleWorkflowTools(registry: ToolRegistry, permissions: ToolPermissionContext): Tool[] {
  return [
    ...registry.list().filter((tool) => !isWorkflowOwnedPlanTool(tool.name) && !isToolExplicitlyDenied(tool.name, permissions)),
    submitNodeResultTool
  ];
}

function isWorkflowOwnedPlanTool(name: string): boolean {
  return name === "EnterPlanMode" || name === "ExitPlanMode";
}

function normalizeRuntimePermissions(permissions: ToolPermissionContext | PermissionSet): ToolPermissionContext {
  if ("mode" in permissions) {
    return {
      ...permissions,
      allow: permissions.allow.slice(),
      ask: permissions.ask.slice(),
      deny: permissions.deny.slice(),
      transientAllow: permissions.transientAllow?.slice() ?? []
    };
  }
  return { mode: "default", source: "workflow", allow: permissions.allow.slice(), ask: permissions.ask.slice(), deny: permissions.deny.slice(), transientAllow: [] };
}

async function restoreSkillPermissions(options: NodeRuntimeOptions, permissions: ToolPermissionContext, attempt: number): Promise<void> {
  const activation = options.activation ?? 1;
  const events = await options.store.loadEvents(options.runId);
  const skills = events.filter((event): event is Extract<StoredEvent, { type: "skill_activated" }> =>
    event.type === "skill_activated"
    && event.node_id === options.node.id
    && (event.attempt ?? 1) === attempt
    && (event.activation ?? 1) === activation
  );
  for (const skill of skills) {
    if (skill.mode === "inline") applySkillPermissionRules(permissions, skill.allowed_tools);
  }
  options.tools.skillRuntime?.restoreSession(options.runId, skills.map((skill) => skill.name));
}

function applySkillPermissionRules(permissions: ToolPermissionContext, rules: string[]): void {
  permissions.transientAllow = [...new Set([...(permissions.transientAllow ?? []), ...rules])];
}

function artifactReadFromToolResult(tool: string, result: ToolResult): { artifact_id: string; offset: number; bytes_read: number; total_bytes: number; truncated: boolean } | undefined {
  if (tool !== "ArtifactRead" || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) return undefined;
  const data = result.data as Record<string, unknown>;
  if (typeof data.artifact_id !== "string" || typeof data.offset !== "number" || typeof data.content !== "string" || typeof data.total_bytes !== "number" || typeof data.truncated !== "boolean") return undefined;
  return { artifact_id: data.artifact_id, offset: data.offset, bytes_read: Buffer.byteLength(data.content, "utf8"), total_bytes: data.total_bytes, truncated: data.truncated };
}

function emptyResponseRepairPrompt(): string {
  return [
    "The previous response contained no user-visible content and no tool calls.",
    "Continue the current task now. Return either the required tool call or exactly one valid NodeResult.",
    "Do not return a thinking-only or empty response."
  ].join("\n");
}

function nodeResultRepairPrompt(error: unknown): string {
  return [
    "The previous response was not a valid final NodeResult.",
    `Validation error: ${errorMessage(error)}`,
    "Return exactly one valid NodeResult JSON object and nothing else.",
    "Do not include multiple JSON objects, Markdown fences, explanations, or revisions.",
    "Use direction backward only when the previous node or the user must respond."
  ].join("\n");
}
function mergeArtifactDeliverables(result: NodeResult, artifacts: NodeResult["deliverables"]): NodeResult {
  if (!artifacts.length) return result;
  const deliverables = [...result.deliverables];
  for (const artifact of artifacts) {
    if (!deliverables.some((item) => item.artifact_id === artifact.artifact_id)) deliverables.push(artifact);
  }
  return { ...result, deliverables };
}
function assistantToolCallContent(content: string | undefined): string {
  return visibleAssistantTextBeforeNodeResult(content ?? "");
}
function shouldRepairToolPreamble(content: string | undefined): boolean {
  return !assistantToolCallContent(content).trim();
}
function toolPreambleRepairPrompt(content: string | undefined, toolCalls: ModelToolCall[]): string {
  return [
    "The previous tool-call turn did not include a user-visible natural-language preamble.",
    "Do not put NodeResult JSON in assistant content before tool calls.",
    "Briefly explain the immediate next action, then resend any non-SubmitNodeResult tool calls that are still needed.",
    `Invalid assistant content excerpt: ${promptExcerpt(content ?? "")}`,
    `Tool calls from the invalid turn: ${promptExcerpt(JSON.stringify(toolCalls))}`
  ].join("\n");
}
function promptExcerpt(text: string): string {
  return text.length > 1000 ? `${text.slice(0, 1000)}...` : text;
}
class RuntimeStreamBatcher {
  private type?: "thinking" | "content";
  private text = "";
  private timer?: NodeJS.Timeout;
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: NodeRuntimeOptions, private readonly attempt: number) {}

  push(type: "thinking" | "content", text: string): void {
    if (!text) return;
    if (this.type && this.type !== type) this.flush();
    this.type = type;
    this.text += text;
    if (this.text.length >= 512) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), 32);
      this.timer.unref();
    }
  }

  async drain(): Promise<void> {
    this.flush();
    await this.writes;
  }

  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.type || !this.text) return;
    const type = this.type;
    const text = this.text;
    this.type = undefined;
    this.text = "";
    this.writes = this.writes.then(() => appendRuntimeEvent(this.options, {
      type: type === "thinking" ? "model_thinking_delta" : "model_stream_delta",
      node_id: this.options.node.id,
      attempt: this.attempt,
      activation: this.options.activation,
      text
    }));
  }
}

async function firstUserInteractionTool(calls: ModelToolCall[], tools: ToolRegistry): Promise<ModelToolCall | undefined> {
  for (const call of calls) {
    if (!tools.has(call.name)) continue;
    if (await tools.get(call.name).requiresUserInteraction?.(call.input)) return call;
  }
  return undefined;
}

function userInputFromToolResult(result: ToolResult | undefined): { questions: NodeResult["questions"] } | undefined {
  const data = result?.data as { type?: unknown; questions?: unknown } | undefined;
  if (data?.type !== "user_input_requested" || !Array.isArray(data.questions)) return undefined;
  return { questions: data.questions as NodeResult["questions"] };
}

async function appendRuntimeEvent(options: NodeRuntimeOptions, event: HarnessEvent): Promise<StoredEvent> {
  const stored = await options.store.appendEvent(options.runId, event);
  options.eventSink?.(stored);
  return stored;
}
async function appendModelUsageEvent(options: NodeRuntimeOptions, attempt: number, model: string, response: ModelResponse): Promise<void> {
  if (!hasModelUsage(response.usage)) return;
  await appendRuntimeEvent(options, { type: "model_usage_recorded", node_id: options.node.id, attempt, activation: options.activation, model, usage: response.usage, stop_reason: response.stopReason });
}

async function appendNonStreamingResponseEvents(options: NodeRuntimeOptions, attempt: number, response: { content?: string; thinking?: string }): Promise<void> {
  if (response.thinking) {
    await appendRuntimeEvent(options, { type: "model_thinking_delta", node_id: options.node.id, attempt, activation: options.activation, text: response.thinking });
  }
  if (response.content) {
    await appendRuntimeEvent(options, { type: "model_stream_delta", node_id: options.node.id, attempt, activation: options.activation, text: response.content });
  }
}
function isAbortLikeError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function modelRetryHarnessEvent(
  options: NodeRuntimeOptions,
  attempt: number,
  operation: "sampling" | "compaction",
  retry: ModelRetryEvent
): HarnessEvent {
  return {
    type: "model_retry_scheduled",
    node_id: options.node.id,
    attempt,
    activation: options.activation,
    operation,
    phase: retry.phase,
    retry_attempt: retry.retryAttempt,
    max_retries: retry.maxRetries,
    retry_in_ms: retry.retryInMs,
    retry_at: retry.retryAt,
    error_kind: retry.errorKind,
    status: retry.status,
    error: retry.message,
    detail: retry.detail,
    discarded_content_chars: retry.discardedContentChars,
    discarded_thinking_chars: retry.discardedThinkingChars
  };
}
function promptCacheKey(runId: string, nodeId: string): string {
  return createHash("sha256").update(`${runId}:${nodeId}`).digest("hex");
}
function toolSpecifier(tool: string, input: unknown): string {
  const value = input as Record<string, unknown>;
  if (tool === "Bash" || tool === "PowerShell") return String(value.command ?? "");
  if (typeof value.file_path === "string") return value.file_path;
  if (typeof value.path === "string") return value.path;
  if (typeof value.url === "string") return value.url;
  return "";
}

async function reconcileInterruptedToolCalls(options: NodeRuntimeOptions, attempt: number, messages: ModelMessage[], artifacts: NodeResult["deliverables"]): Promise<ModelMessage[]> {
  const existingToolResults = new Set(messages.filter((message) => message.role === "tool" && message.tool_call_id).map((message) => message.tool_call_id));
  const events = await options.store.loadEvents(options.runId);
  const allRecovered: ModelMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    const recovered: ModelMessage[] = [];
    for (const call of message.tool_calls) {
      if (existingToolResults.has(call.id)) continue;
      if (call.name === submitNodeResultTool.name) {
        recovered.push(submitNodeResultToolMessage(call.id));
        existingToolResults.add(call.id);
        continue;
      }
      const ledger = toolCallLedger(events, options.node.id, attempt, options.activation ?? 1, call.id);
      if (ledger.completed) {
        recovered.push({
          role: "tool",
          tool_call_id: call.id,
          content: modelToolResultContent(ledger.completed.result, {
            tokenLimit: getModelContextLimits(options.model, options.modelRegistry, options.maxOutputTokens).toolOutputTokenLimit
          })
        });
        const artifact = artifactFromToolResult(ledger.completed.result as ToolResult);
        if (artifact && !artifacts.some((item) => item.artifact_id === artifact.artifact_id)) artifacts.push({ artifact_id: artifact.artifact_id, description: artifact.description });
      } else if (ledger.failed) {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: ledger.failed.error }) });
      } else if (ledger.invoked) {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Tool execution outcome is unknown after interruption. This call will not be executed again automatically." }) });
      } else {
        recovered.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ error: "Tool execution did not start before interruption. Resend the call if it is still required." }) });
      }
      existingToolResults.add(call.id);
    }
    if (recovered.length) {
      messages.splice(index + 1, 0, ...recovered);
      allRecovered.push(...recovered);
      index += recovered.length;
    }
  }
  return allRecovered;
}

function assertResolvedToolCallHistory(messages: ModelMessage[]): void {
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
    if (unresolved.size) {
      throw new Error(`Invalid model dialogue: unresolved tool calls before the next turn: ${[...unresolved].join(", ")}`);
    }
  }
}

async function assertToolCallCanExecute(options: NodeRuntimeOptions, attempt: number, call: ModelToolCall, tool: Tool): Promise<void> {
  const activation = options.activation ?? 1;
  const events = await options.store.loadEvents(options.runId);
  const sameId = toolCallLedger(events, options.node.id, attempt, activation, call.id);
  if (sameId.completed || sameId.failed || sameId.invoked) throw new Error(`Tool call ${call.id} was already recorded and will not be executed again`);
  const fingerprint = toolInputFingerprint(call.name, call.input);
  const invoked = events.filter((event): event is Extract<StoredEvent, { type: "tool_invoked" }> =>
    event.type === "tool_invoked"
    && event.node_id === options.node.id
    && (event.attempt ?? 1) === attempt
    && (event.activation ?? 1) === activation
    && toolInputFingerprint(event.tool, event.input) === fingerprint
  );
  const inDoubt = invoked.some((event) => {
    const ledger = toolCallLedger(events, options.node.id, attempt, activation, event.tool_call_id ?? "");
    return !ledger.completed && !ledger.failed;
  });
  if (inDoubt && tool.isReadOnly?.(call.input, { cwd: options.cwd, runDir: options.store.runDir(options.runId), nodeId: options.node.id, attempt, activation }) !== true) {
    throw new Error(`Refusing to repeat non-read-only tool ${call.name}: an equivalent call has an unknown outcome after interruption`);
  }
}

function toolCallLedger(events: StoredEvent[], nodeId: string, attempt: number, activation: number, toolCallId: string): {
  invoked?: Extract<StoredEvent, { type: "tool_invoked" }>;
  completed?: Extract<StoredEvent, { type: "tool_completed" }>;
  failed?: Extract<StoredEvent, { type: "tool_failed" }>;
} {
  const relevant = events.filter((event) =>
    (event.type === "tool_invoked" || event.type === "tool_completed" || event.type === "tool_failed")
    && event.node_id === nodeId
    && (event.attempt ?? 1) === attempt
    && (event.activation ?? 1) === activation
    && event.tool_call_id === toolCallId
  );
  const reversed = [...relevant].reverse();
  return {
    invoked: reversed.find((event): event is Extract<StoredEvent, { type: "tool_invoked" }> => event.type === "tool_invoked"),
    completed: reversed.find((event): event is Extract<StoredEvent, { type: "tool_completed" }> => event.type === "tool_completed"),
    failed: reversed.find((event): event is Extract<StoredEvent, { type: "tool_failed" }> => event.type === "tool_failed")
  };
}

function blockedShellStrategyFailure(
  call: ModelToolCall,
  failures: ReadonlyMap<string, { category: string; count: number }>
): ToolResult | undefined {
  if (!isShellToolName(call.name)) return undefined;
  for (const failure of failures.values()) {
    if (failure.count < 2 || !shellCallMatchesFailureCategory(failure.category, call.input)) continue;
    return toolPolicyFailureResult(
      "tool.strategy_blocked",
      "This shell strategy has already failed twice in the current activation. Do not retry it; switch to Read/Edit/MultiEdit/Write or another method.",
      call.name + ":" + failure.category
    );
  }
  return undefined;
}

function toolInputFingerprint(tool: string, input: unknown): string {
  return createHash("sha256").update(`${tool}:${stableJson(input)}`).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
