import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative } from "node:path";
import { useEffect, useRef, useState } from "react";
import { Box, ScrollBox, Text, useApp, useHasSelection, useInput, useSelection, useStdin, useStdout } from "./ink.js";
import type { ScrollBoxHandle } from "./ink.js";
import { useCopyOnSelect } from "../ink/hooks/use-copy-on-select.js";
import { AgentTeamConfig } from "../config/schema.js";
import type { RuntimeDiagnostics } from "../diagnostics/runtimeDiagnostics.js";
import { enterPlanMode, readPlanOrRecoverFromTranscript } from "../plans/planSession.js";
import type { PlanRequestedPermission, PlanSessionState } from "../plans/planSession.js";
import { PlanModeController } from "../kernel/plan/planModeController.js";
import { closeDanglingExitPlanModeToolCalls, planApprovalToolResultContent } from "../kernel/plan/planToolCallMessages.js";
import { QueryEngine } from "../kernel/queryEngine.js";
import { createKernelToolRegistry } from "../kernel/tools/registry.js";
import type { DefaultExecutionMode, KernelSession, PendingInteraction } from "../kernel/session.js";
import { readPlan } from "../plans/planFiles.js";
import { getModelContextLimits, getModelContextWindow, getProviderMaxOutputTokens, modelRegistryFromProviderConfig } from "../model/modelRegistry.js";
import { addModelUsage, emptyModelUsage } from "../model/usage.js";
import type { ModelUsage } from "../model/usage.js";
import { resolveEffortForWorkflowNode, resolveModelForWorkflowNode } from "../model/modelRouting.js";
import type { ModelContentPart, ModelMessage, ModelProvider } from "../providers/types.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";
import type { RuntimeEvent } from "../runtime/types.js";
import { loadMergedMcpServersWithSourceDetails, type McpConfigSourceOptions } from "../mcp/config.js";
import { setMcpServerDisabledState } from "../mcp/configMutations.js";
import type { McpRuntime } from "../mcp/runtime.js";
import { loadDisabledSkillNames, setSkillDisabledState, watchDisabledSkillNames, type SkillAvailabilityOptions } from "../skills/availability.js";
import type { SkillRuntime } from "../skills/runtime.js";
import type { ResolvedAgentTeamSettings } from "../settings/types.js";
import type { PromptHistoryStore } from "../storage/promptHistoryStore.js";
import { SessionStore } from "../storage/sessionStore.js";
import { askUserQuestionModelResult } from "../tools/local/askUserQuestion.js";
import { createLocalToolRegistry } from "../tools/registry.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { WorkflowSession } from "../workflow/session.js";
import { initialTuiState, reduceStoredEvent, resetTuiRunState } from "./eventAdapter.js";
import { ensureRefableStdin } from "./inkStdin.js";
import { TuiDefaultExecutionMode, TuiState } from "./state.js";
import type { TuiLogMessage } from "./logTypes.js";
import { Header } from "./components/Header.js";
import { InteractionArea, InteractionChoice } from "./components/InteractionArea.js";
import { buildMcpListChoice, buildMcpServerChoice, buildMcpToolDetailChoice, buildMcpToolsChoice, buildSkillsDetailChoice, buildSkillsListChoice, buildStatuslineChoice, type McpMenuAction } from "./commandMenus/index.js";
import type { SelectImageAttachment } from "./components/CustomSelect/index.js";
import { PromptInputEvent, PromptInputImageAttachment, PromptInputMode } from "./components/PromptInput/types.js";
import { ResultPanel } from "./components/ResultPanel.js";
import { MainScrollBar } from "./components/MainScrollBar.js";
import { RunLogPanel } from "./components/RunLogPanel.js";
import { availableStatusLineElements, defaultStatusLineElements, StatusLine } from "./components/StatusLine.js";
import type { StatusLineElement } from "./components/StatusLine.js";
import { WorkflowFlowChart } from "./components/WorkflowFlowChart.js";
import { editFileInExternalEditor, editTextInExternalEditor, externalEditorDisplayName, ExternalEditor, ExternalTextEditor } from "./externalEditor.js";
import { resolveImagePaste } from "./imagePaste.js";
import { getCompactToolResultDetail, getToolDisplayName, getToolInputDetail, getToolInputSummary, getToolResultDetail } from "./toolDisplay.js";

export type CommandMenuState =
  | { kind: "skills:list" }
  | { kind: "skills:detail"; skillName: string }
  | { kind: "statusline" }
  | { kind: "mcp:list" }
  | { kind: "mcp:server"; serverName: string }
  | { kind: "mcp:tools"; serverName: string }
  | { kind: "mcp:toolDetail"; serverName: string; toolName: string };

type McpActionResult = { title: string; detail: string };
type QueuedPrompt = { text: string; images: PromptInputImageAttachment[] };
const SKILL_SETTINGS_RELOAD_ERROR_PREFIX = "Failed to reload skill settings: ";
export function TuiApp({
  cwd,
  initialError,
  config,
  workflows = [],
  workflowId,
  engine,
  providerFactory,
  editPlanFile = editFileInExternalEditor,
  editQuestionText = (text: string) => editTextInExternalEditor(text, cwd),
  planSavedMessageDurationMs = 5000,
  settings,
  promptHistoryStore,
  sessionStore: providedSessionStore,
  mcpRuntime,
  skillRuntime,
  diagnostics,
  collectDiagnostics,
  mcpConfigOptions,
  skillConfigOptions,
  executeMcpActionForTest,
  saveDefaultPermissionMode,
  onExit
}: {
  cwd: string;
  initialError?: string;
  config?: AgentTeamConfig;
  workflows?: string[];
  workflowId?: string;
  engine?: WorkflowEngine;
  providerFactory?: (providerId: string) => ModelProvider;
  editPlanFile?: ExternalEditor;
  editQuestionText?: ExternalTextEditor;
  planSavedMessageDurationMs?: number;
  settings?: ResolvedAgentTeamSettings;
  promptHistoryStore?: PromptHistoryStore;
  sessionStore?: SessionStore;
  mcpRuntime?: McpRuntime;
  skillRuntime?: SkillRuntime;
  diagnostics?: RuntimeDiagnostics;
  collectDiagnostics?: () => RuntimeDiagnostics;
  mcpConfigOptions?: McpConfigSourceOptions;
  skillConfigOptions?: SkillAvailabilityOptions;
  executeMcpActionForTest?: (action: McpMenuAction, serverName?: string) => Promise<McpActionResult>;
  saveDefaultPermissionMode?: (mode: TuiDefaultExecutionMode) => Promise<void>;
  onExit?: () => void;
}) {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const selection = useSelection();
  const hasSelection = useHasSelection();
  const selectionEscapeConsumedRef = useRef(false);
  useCopyOnSelect(selection, settings?.copyOnSelect ?? true);
  ensureRefableStdin(stdin);
  const terminalRows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  const terminalColumns = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  const exitTui = onExit ?? exit;
  const initialWorkflowId = workflowId;
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(initialWorkflowId);
  const [previewWorkflowId, setPreviewWorkflowId] = useState(initialWorkflowId ?? workflows[0]);
  const [state, setState] = useState<TuiState>(() => ({
    ...initialTuiState({ cwd, inputPermissionMode: settings?.permissions?.defaultMode ?? "default" }),
    mode: initialWorkflowId ? "input" as const : workflows.length ? "select_workflow" as const : "input" as const,
    workflowId: initialWorkflowId
  }));
  const [queued, setQueued] = useState<QueuedPrompt[]>([]);
  const [promptText, setPromptText] = useState("");
  const [statuslineElements, setStatuslineElements] = useState<StatusLineElement[]>(defaultStatusLineElements);
  const [planWorkCount, setPlanWorkCount] = useState(0);
  const [workStartedAtMs, setWorkStartedAtMs] = useState<number>();
  const [lastWorkDurationMs, setLastWorkDurationMs] = useState<number>();
  const [workStatusDetail, setWorkStatusDetail] = useState<string>();
  const [planApprovalCollapsed, setPlanApprovalCollapsed] = useState(false);
  const [planApprovalDocumentOffset, setPlanApprovalDocumentOffset] = useState(0);
  const [clockMs, setClockMs] = useState(() => Date.now());
  const [transcriptMode, setTranscriptMode] = useState(false);
  const [choiceKey, setChoiceKey] = useState("");
  const [commandMenu, setCommandMenu] = useState<CommandMenuState | undefined>();
  const [pendingSkillNames, setPendingSkillNames] = useState<string[]>([]);
  const pendingSkillNamesRef = useRef(new Set<string>());
  const [, setSkillAvailabilityRevision] = useState(0);
  const [, setMcpStatusRevision] = useState(0);
  const mainScrollRef = useRef<ScrollBoxHandle>(null);
  const sessionRef = useRef<WorkflowSession>();
  const planSessionRef = useRef<PlanSessionState>();
  const planMessagesRef = useRef<ModelMessage[]>([]);
  const planQuestionRef = useRef<{ toolCallId: string; questions: unknown[]; index: number; answers: Record<string, unknown> }>();
  const planTurnQueueRef = useRef<Promise<void>>(Promise.resolve());
  const planAbortControllerRef = useRef<AbortController>();
  const planTurnGenerationRef = useRef(0);
  const planTranscriptWriteRef = useRef<Promise<void>>(Promise.resolve());
  const planAuditWriteRef = useRef<Promise<void>>(Promise.resolve());
  const planApprovalFeedbackRef = useRef("");
  const planApprovalImagesRef = useRef<SelectImageAttachment[]>([]);
  const planApprovalImageIdRef = useRef(1);
  const persistedDefaultExecutionModeRef = useRef(settings?.permissions?.defaultMode);
  const [planApprovalImages, setPlanApprovalImages] = useState<SelectImageAttachment[]>([]);
  const planQuestionImagesRef = useRef<Record<string, SelectImageAttachment[]>>({});
  const planQuestionImageIdRef = useRef(1);
  const [planQuestionImages, setPlanQuestionImages] = useState<Record<string, SelectImageAttachment[]>>({});
  const sessionStoreRef = useRef<SessionStore>();
  if (!sessionStoreRef.current) sessionStoreRef.current = providedSessionStore ?? new SessionStore(join(cwd, ".einsteins", "projects", "tui"));
  const sessionStore = sessionStoreRef.current;
  const currentSessionIdRef = useRef(promptHistoryStore?.sessionId ?? randomUUID());
  const sessionAuditGenerationRef = useRef(0);
  const listeningSessionRef = useRef<WorkflowSession>();
  const sessionResultGenerationRef = useRef(0);
  const queuedContinuationRef = useRef(false);
  const abandonedRunIdsRef = useRef<Set<string>>(new Set());
  const lastWorkflowPromptRef = useRef("");
  const canceledChoiceKeyRef = useRef<string>();
  const defaultPlanModeStartedRef = useRef(false);
  const scrollMainAfterRenderRef = useRef(false);
  useEffect(() => {
    if (!mcpRuntime) return;
    return mcpRuntime.subscribe(() => setMcpStatusRevision((current) => current + 1));
  }, [mcpRuntime]);
  useEffect(() => {
    if (!skillRuntime || !skillConfigOptions) return;
    const apply = (disabledSkillNames: string[]) => {
      skillRuntime.setDisabledSkillNames(disabledSkillNames);
      setSkillAvailabilityRevision((current) => current + 1);
      setState((current) => current.error?.startsWith(SKILL_SETTINGS_RELOAD_ERROR_PREFIX) ? { ...current, error: undefined } : current);
    };
    const reportError = (error: Error) => setState((current) => ({ ...current, error: `${SKILL_SETTINGS_RELOAD_ERROR_PREFIX}${error.message}` }));
    void loadDisabledSkillNames(skillConfigOptions).then(apply).catch((error) => reportError(error instanceof Error ? error : new Error(String(error))));
    return watchDisabledSkillNames(skillConfigOptions, { onChange: apply, onError: reportError });
  }, [skillRuntime, skillConfigOptions?.cwd, skillConfigOptions?.userSettingsPath]);
  const resetPlanApprovalFeedback = () => {
    planApprovalFeedbackRef.current = "";
    planApprovalImagesRef.current = [];
    setPlanApprovalImages([]);
  };
  const addPlanApprovalImage = (image: Omit<SelectImageAttachment, "id">) => {
    const next = [...planApprovalImagesRef.current, { ...image, id: planApprovalImageIdRef.current++ }];
    planApprovalImagesRef.current = next;
    setPlanApprovalImages(next);
  };
  const resolvePlanApprovalImagePaste = (value: string) => resolveImagePaste(value, { cwd });
  const removePlanApprovalImage = (id: number) => {
    const next = planApprovalImagesRef.current.filter((image) => image.id !== id);
    planApprovalImagesRef.current = next;
    setPlanApprovalImages(next);
  };
  const resetPlanQuestionImages = () => {
    planQuestionImagesRef.current = {};
    setPlanQuestionImages({});
  };
  const addPlanQuestionImage = (question: string, image: Omit<SelectImageAttachment, "id">) => {
    const current = planQuestionImagesRef.current[question] ?? [];
    const next = { ...planQuestionImagesRef.current, [question]: [...current, { ...image, id: planQuestionImageIdRef.current++ }] };
    planQuestionImagesRef.current = next;
    setPlanQuestionImages(next);
  };
  const removePlanQuestionImage = (question: string, id: number) => {
    const nextQuestionImages = (planQuestionImagesRef.current[question] ?? []).filter((image) => image.id !== id);
    const next = { ...planQuestionImagesRef.current, [question]: nextQuestionImages };
    planQuestionImagesRef.current = next;
    setPlanQuestionImages(next);
  };
  const resolvePlanQuestionImagePaste = (value: string) => resolveImagePaste(value, { cwd });
  const resolvePlanPromptImagePaste = (value: string) => resolveImagePaste(value, { cwd });
  const planApprovalFeedbackPayload = (): unknown => {
    const answer = planApprovalFeedbackRef.current.trim();
    const contentBlocks = planApprovalImagesRef.current.map(({ type, media_type, data }) => ({ type, media_type, data }));
    if (contentBlocks.length) return { ...(answer ? { answer } : {}), contentBlocks };
    return answer || undefined;
  };
  const planApprovalAcceptFeedback = (): unknown => {
    const answer = planApprovalFeedbackRef.current.trim();
    return answer || undefined;
  };
  const hasPlanApprovalFeedback = (): boolean => planApprovalFeedbackPayload() !== undefined;
  const planApprovalPromptFeedback = (text: string, images: PromptInputImageAttachment[] = []): unknown => {
    const feedbackTextValue = [text, planApprovalFeedbackRef.current]
      .map((value) => value.trim())
      .sort((left, right) => right.length - left.length)[0] ?? "";
    const parsed = imageFeedbackFromText(feedbackTextValue);
    const contentBlocks = uniqueImageBlocks([
      ...planApprovalImagesRef.current.map(({ type, media_type, data }) => ({ type, media_type, data })),
      ...images.map(({ type, media_type, data }) => ({ type, media_type, data })),
      ...parsed.contentBlocks
    ]);
    if (contentBlocks.length) return { ...(parsed.answer ? { answer: parsed.answer } : {}), contentBlocks };
    return parsed.answer || undefined;
  };
  const handlePromptTextChange = (text: string) => {
    setPromptText(text);
  };
  const planQuestionImageBlocks = (): ModelContentPart[] => uniqueImageBlocks(
    Object.values(planQuestionImagesRef.current)
      .flat()
      .map(({ type, media_type, data }) => ({ type, media_type, data }))
  );
  const planQuestionContinuationMessages = (toolCallId: string, payload: unknown): ModelMessage[] => {
    const mapped = askUserQuestionModelResult(payload);
    const toolResultMessage: ModelMessage = { role: "tool" as const, tool_call_id: toolCallId, content: typeof mapped === "string" ? mapped : JSON.stringify(mapped) };
    const contentBlocks = planQuestionImageBlocks();
    if (!contentBlocks.length) return [toolResultMessage];
    return [
      toolResultMessage,
      {
        role: "user",
        content: [
          { type: "text", text: "The user attached image feedback while answering AskUserQuestion." },
          ...contentBlocks
        ]
      }
    ];
  };
  const requestMainScrollToBottom = () => {
    scrollMainAfterRenderRef.current = true;
    mainScrollRef.current?.scrollToBottom();
    queueMicrotask(() => mainScrollRef.current?.scrollToBottom());
    setTimeout(() => mainScrollRef.current?.scrollToBottom(), 0);
  };
  useEffect(() => {
    if (!scrollMainAfterRenderRef.current) return;
    scrollMainAfterRenderRef.current = false;
    mainScrollRef.current?.scrollToBottom();
  }, [state.logMessages.length, state.mode]);
  useEffect(() => {
    setPlanApprovalCollapsed(false);
    setPlanApprovalDocumentOffset(0);
  }, [state.pendingReview?.nodeId, state.pendingReview?.attempt, state.pendingReview?.planFilePath, state.pendingReview?.document]);
  useEffect(() => {
    const review = state.pendingReview;
    if (!review?.savedMessage) return;
    const timer = setTimeout(() => {
      setState((current) => {
        const pending = current.pendingReview;
        if (
          !pending ||
          pending.nodeId !== review.nodeId ||
          pending.attempt !== review.attempt ||
          pending.savedMessage !== review.savedMessage
        ) {
          return current;
        }
        const { savedMessage: _savedMessage, ...pendingWithoutSavedMessage } = pending;
        return { ...current, pendingReview: pendingWithoutSavedMessage };
      });
    }, planSavedMessageDurationMs);
    return () => clearTimeout(timer);
  }, [planSavedMessageDurationMs, state.pendingReview?.attempt, state.pendingReview?.nodeId, state.pendingReview?.savedMessage]);
  const selectWorkflow = (workflow: string) => {
    if (!config?.workflows[workflow]) return;
    setPreviewWorkflowId(workflow);
    setSelectedWorkflowId(workflow);
    setState((current) => ({ ...current, workflowId: workflow, mode: "input" }));
  };
  const failUi = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState((current) => ({ ...current, mode: "failed", error: message }));
  };
  const interruptAndExit = () => {
    const session = sessionRef.current;
    if (!session) {
      exitTui();
      return;
    }
    void session.interrupt().finally(() => exitTui());
  };
  const handleCtrlC = () => {
    const behavior = resolveCtrlCBehavior(state.mode, Boolean(sessionRef.current || planSessionRef.current), hasSelection || selection.hasSelection());
    if (behavior === "copy_selection") {
      selection.copySelection();
      return;
    }
    if (behavior === "exit") {
      exitTui();
      return;
    }
    if (behavior === "confirm_interrupt") {
      setState((current) => ({ ...current, mode: "confirm_interrupt", modeBeforeConfirmation: current.mode }));
      return;
    }
    interruptAndExit();
  };
  useEffect(() => {
    const handleData = (value: unknown) => {
      const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
      if (!text.includes("\u0003")) return;
      handleCtrlC();
    };
    stdin.on?.("data", handleData);
    return () => {
      stdin.off?.("data", handleData);
    };
  }, [stdin, state.mode, hasSelection, selection]);
  const refreshSessionAudit = async (sessionId: string) => {
    const generation = sessionAuditGenerationRef.current + 1;
    sessionAuditGenerationRef.current = generation;
    const metadata = await sessionStore.loadMetadata(sessionId);
    if (currentSessionIdRef.current !== sessionId || sessionAuditGenerationRef.current !== generation) return;
    setState((current) => ({
      ...current,
      sessionUsage: metadata?.usage ?? emptyModelUsage(),
      modelRequestCount: metadata?.modelRequestCount ?? 0
    }));
  };
  const resetSession = () => {
    sessionResultGenerationRef.current += 1;
    queuedContinuationRef.current = false;
    sessionRef.current = undefined;
    currentSessionIdRef.current = randomUUID();
    sessionAuditGenerationRef.current += 1;
    planSessionRef.current = undefined;
    resetPlanApprovalFeedback();
    resetPlanQuestionImages();
    setQueued([]);
    setState((current) => ({
      ...initialTuiState({ cwd: current.cwd, inputPermissionMode: current.inputPermissionMode }),
      workflowId: selectedWorkflowId,
      mode: selectedWorkflowId ? "input" : "select_workflow"
    }));
  };
  const listenSession = (session: WorkflowSession, nextWorkflowId: string) => {
    if (listeningSessionRef.current === session) return;
    listeningSessionRef.current = session;
    void (async () => {
      try {
        for await (const event of session.events) {
          if (abandonedRunIdsRef.current.has(session.runId)) continue;
          if (event.type === "model_response_recorded") sessionAuditGenerationRef.current += 1;
          setState((current) => reduceStoredEvent({ ...current, runId: session.runId, workflowId: nextWorkflowId }, event));
        }
      } finally {
        if (listeningSessionRef.current === session) listeningSessionRef.current = undefined;
      }
    })();
  };
  const attachSession = (session: WorkflowSession, nextWorkflowId: string, options: { preserveLogs?: boolean; inputPermissionMode?: PermissionMode } = {}) => {
    const resultGeneration = ++sessionResultGenerationRef.current;
    sessionRef.current = session;
    const sessionId = session.sessionId ?? currentSessionIdRef.current;
    currentSessionIdRef.current = sessionId;
    if (providedSessionStore) void sessionStore.attachRun(sessionId, session.runId).catch((error) => failUi(error));
    void refreshSessionAudit(sessionId).catch((error) => failUi(error));
    mainScrollRef.current?.scrollToBottom();
    setState((current) => resetTuiRunState(current, { workflowId: nextWorkflowId, runId: session.runId, preserveLogs: options.preserveLogs === true, inputPermissionMode: options.inputPermissionMode }));
    listenSession(session, nextWorkflowId);
    void session.result
      .then((result) => {
        if (abandonedRunIdsRef.current.has(session.runId) || sessionResultGenerationRef.current !== resultGeneration) return;
        setState((current) => ({
          ...current,
          mode: workflowResultMode(result.status),
          workflowId: nextWorkflowId,
          runId: session.runId
        }));
      })
      .catch((error) => {
        if (abandonedRunIdsRef.current.has(session.runId) || sessionResultGenerationRef.current !== resultGeneration) return;
        failUi(error);
      });
  };

  const startWorkflowInput = async (input: unknown, options: { permissionMode?: Exclude<PermissionMode, "plan">; clearContext?: boolean; preserveLogs?: boolean; inputPermissionMode?: PermissionMode; sessionId?: string } = {}) => {
    if (!config || !engine) {
      failUi("TUI is missing workflow configuration");
      return;
    }
    if (!selectedWorkflowId) {
      setState((current) => ({ ...current, mode: "select_workflow" }));
      return;
    }
    try {
      const session = await engine.startInteractive(config, selectedWorkflowId, input, {
        permissionMode: options.permissionMode ?? workflowPermissionMode(state.inputPermissionMode),
        ...(options.clearContext === true ? { clearContext: true } : {}),
        sessionId: options.sessionId ?? currentSessionIdRef.current
      });
      attachSession(session, selectedWorkflowId, { preserveLogs: options.preserveLogs === true, inputPermissionMode: options.inputPermissionMode });
    } catch (error) {
      failUi(error);
    }
  };
  const startRun = async (text: string, images: PromptInputImageAttachment[] = []) => {
    lastWorkflowPromptRef.current = text;
    await startWorkflowInput({ request: text, images }, { sessionId: currentSessionIdRef.current });
  };

  const resumeRun = async (runId: string) => {
    if (!config || !engine) {
      failUi("TUI is missing workflow configuration");
      return;
    }
    try {
      const session = await engine.resumeInteractive(config, runId);
      currentSessionIdRef.current = session.sessionId ?? currentSessionIdRef.current;
      setSelectedWorkflowId(session.state.workflow_id);
      attachSession(session, session.state.workflow_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({ ...current, mode: "input", error: message, resumeRuns: [], pendingResumeRunId: undefined, modeBeforeConfirmation: undefined }));
    }
  };
  const continueSession = (text: string, images: PromptInputImageAttachment[] = []): Promise<void> => {
    const session = sessionRef.current;
    const nextWorkflowId = state.workflowId ?? selectedWorkflowId ?? session?.state.workflow_id;
    if (!session || !nextWorkflowId) {
      return startRun(text, images);
    }
    sessionResultGenerationRef.current += 1;
    lastWorkflowPromptRef.current = text;
    setState((current) => ({ ...current, mode: "running", error: undefined }));
    const continuation = session.continueWithInput({ request: text, images });
    listenSession(session, nextWorkflowId);
    return continuation;
  };
  const resumeSession = (text: string) => {
    const session = sessionRef.current;
    if (!session) {
      void startRun(text);
      return;
    }
    lastWorkflowPromptRef.current = text;
    setState((current) => ({ ...current, mode: "running", questions: [], error: undefined }));
    void session.resumeWithUserInput({ answer: text }).catch((error) => failUi(error));
  };
  useEffect(() => {
    if (state.mode !== "completed") {
      queuedContinuationRef.current = false;
      return;
    }
    const next = queued[0];
    if (!next || queuedContinuationRef.current) return;
    queuedContinuationRef.current = true;
    setQueued((current) => current.slice(1));
    void continueSession(next.text, next.images).catch((error) => {
      setQueued((current) => [next, ...current]);
      failUi(error);
    });
  }, [queued, state.mode]);
  const savePlanSession = (plan: PlanSessionState) => {
    void sessionStore.savePlanState(plan.sessionId, plan).catch((error) => failUi(error));
  };
  const appendPlanTranscriptMessages = (sessionId: string, messages: ModelMessage[]) => {
    if (!messages.length) return;
    planTranscriptWriteRef.current = planTranscriptWriteRef.current
      .then(async () => {
        for (const message of messages) {
          await sessionStore.appendTranscript(sessionId, message);
        }
      })
      .catch((error) => failUi(error));
  };
  const enterGlobalPlanMode = () => {
    const previousPlan = planSessionRef.current;
    const reentry = Boolean(previousPlan?.mode === "inactive" && previousPlan.approvedPlan?.trim());
    const sessionId = reentry ? previousPlan?.sessionId ?? currentSessionIdRef.current : currentSessionIdRef.current;
    currentSessionIdRef.current = sessionId;
    const planFilePath = reentry && previousPlan?.planFilePath
      ? previousPlan.planFilePath
      : join(sessionStore.sessionDir(sessionId), "plans", "plan.md");
    const entered = enterPlanMode({
      sessionId,
      cwd,
      originalInput: { request: "" },
      permissions: {
        mode: state.defaultExecutionMode,
        allow: [],
        ask: [],
        deny: [],
        source: persistedDefaultExecutionModeRef.current === state.defaultExecutionMode ? "settings" : "session",
        planFilePath
      },
      reentry
    });
    planSessionRef.current = entered.state;
    planMessagesRef.current = [];
    savePlanSession(entered.state);
    setState((current) => ({
      ...current,
      mode: "planning",
      inputPermissionMode: "plan",
      planSession: entered.state,
      pendingReview: undefined,
      error: undefined,
      conversation: [...current.conversation, { kind: "status", text: "Enabled plan mode" }],
      logMessages: [...current.logMessages, statusLog("Enabled plan mode", entered.state.planFilePath)]
    }));
  };
  useEffect(() => {
    if (defaultPlanModeStartedRef.current) return;
    if (state.mode !== "input") return;
    if (settings?.planMode?.defaultEntry !== true && settings?.permissions?.defaultMode !== "plan") return;
    defaultPlanModeStartedRef.current = true;
    enterGlobalPlanMode();
  }, [settings?.permissions?.defaultMode, settings?.planMode?.defaultEntry, state.mode]);
  const isWorking = state.mode === "running" || state.mode === "permission" || planWorkCount > 0;
  useEffect(() => {
    if (!isWorking) return;
    const timer = setInterval(() => setClockMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isWorking]);
  useEffect(() => {
    if (isWorking) {
      if (workStartedAtMs === undefined) {
        const now = Date.now();
        setWorkStartedAtMs(now);
        setClockMs(now);
      }
      return;
    }
    if (workStartedAtMs !== undefined) {
      const duration = Math.max(0, Date.now() - workStartedAtMs);
      setLastWorkDurationMs(duration);
      setWorkStartedAtMs(undefined);
    }
    setWorkStatusDetail(undefined);
  }, [isWorking, workStartedAtMs]);
  const executePlanMessages = async (currentPlan: PlanSessionState, messages: ModelMessage[], options: { ensureUserLogText?: string } = {}) => {
    const providerSelection = selectPlanProvider({ config, workflowId: selectedWorkflowId ?? state.workflowId, providerFactory });
    if (!providerSelection) {
      failUi("Plan Mode is missing provider configuration");
      return;
    }
    const turnGeneration = planTurnGenerationRef.current + 1;
    planTurnGenerationRef.current = turnGeneration;
    planAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    planAbortControllerRef.current = abortController;
    setPlanWorkCount((current) => current + 1);
    let lastUsage: ModelUsage | undefined;
    try {
      const legacyTools = createLocalToolRegistry({ mcpRuntime, skillRuntime });
      const kernelSession: KernelSession = {
        id: currentPlan.sessionId,
        cwd,
        status: "planning",
        messages,
        toolPermissionContext: {
          mode: "plan",
          prePlanMode: currentPlan.prePlanMode,
          allow: [],
          ask: [],
          deny: [],
          planFilePath: currentPlan.planFilePath
        },
        defaultExecutionMode: state.defaultExecutionMode,
        planState: currentPlan,
        workflowBinding: null,
        pendingInteraction: null
      };
      const result = await new QueryEngine().run({
        session: kernelSession,
        model: providerSelection.model,
        effort: providerSelection.effort,
        provider: providerSelection.provider,
        tools: createKernelToolRegistry(legacyTools),
        nodeId: "runtime",
        globalPrompt: config?.global_prompt,
        globalPromptMetadata: config?.global_prompt_metadata,
            signal: abortController.signal,
        eventSink: async (event) => {
          if (planTurnGenerationRef.current !== turnGeneration) return;
          if (abortController.signal.aborted && event.type !== "runtime_model_response") return;
          if (event.type === "runtime_prompt_injection") {
            void sessionStore.saveMetadata(currentPlan.sessionId, { promptInjection: { globalPrompt: event.record } }).catch((error) => failUi(error));
          }
          if (event.type === "runtime_model_response") {
            sessionAuditGenerationRef.current += 1;
            setState((current) => ({
              ...current,
              sessionUsage: addModelUsage(current.sessionUsage, event.usage),
              modelRequestCount: current.modelRequestCount + 1
            }));
            planAuditWriteRef.current = planAuditWriteRef.current
              .then(async () => { await sessionStore.recordModelResponse(currentPlan.sessionId, event.usage); })
              .catch((error) => failUi(error));
          }
          if (event.type === "runtime_model_usage") lastUsage = event.usage;
          const detail = runtimeWorkStatusDetail(event);
          if (detail !== undefined) setWorkStatusDetail(detail);
          setState((current) => reducePlanRuntimeEvent(current, event));
          requestMainScrollToBottom();
        }
      });
      if (planTurnGenerationRef.current !== turnGeneration) return;
      const newMessages = planRuntimeNewMessages(messages, result.session.messages);
      planMessagesRef.current = result.session.messages;
      appendPlanTranscriptMessages(currentPlan.sessionId, newMessages);

      const pending = result.session.pendingInteraction;
      if (pending?.type === "ask_user_question") {
        resetPlanQuestionImages();
        planQuestionRef.current = { toolCallId: pending.toolCallId, questions: pending.questions, index: 0, answers: {} };
        setState((current) => ({
          ...current,
          mode: "question",
          questions: nextQuestionSlice(pending.questions, 0),
          error: undefined,
          logMessages: [...current.logMessages, statusLog("Plan Mode needs user input", questionLogDetail(pending.questions))]
        }));
        requestMainScrollToBottom();
        return;
      }
      if (pending?.type === "plan_approval") {
        resetPlanApprovalFeedback();
        const document = (await readPlan(pending.planFilePath))?.trim() ?? "";
        const empty = pending.empty === true || !document.trim();
        const nextPlan = result.session.planState ?? currentPlan;
        planSessionRef.current = nextPlan;
        savePlanSession(nextPlan);
        setState((current) => ({
          ...current,
          mode: "waiting_plan_approval",
          planSession: nextPlan,
          pendingReview: {
            type: "plan",
            nodeId: "global-plan",
            attempt: 1,
            document,
            planFilePath: pending.planFilePath,
            empty,
            requestedPermissions: pending.requestedPermissions,
            toolCallId: pending.toolCallId,
            contextUsedPercent: contextUsedPercent(lastUsage, providerSelection.contextWindow)
          },
          error: undefined,
          conversation: [...current.conversation, { kind: "status", text: empty ? "Exit Plan Mode requested" : "Plan approval requested" }],
          logMessages: [...current.logMessages, globalPlanLog(document, pending.planFilePath, pending.requestedPermissions, empty)]
        }));
        requestMainScrollToBottom();
        return;
      }
      if (result.session.planState) {
        planSessionRef.current = result.session.planState;
        savePlanSession(result.session.planState);
      }
      setState((current) => ({
        ...appendPlanAssistantLogsFromMessages(appendMissingUserLogMessage(current, options.ensureUserLogText), newMessages),
        mode: "planning",
        pendingReview: undefined,
        error: undefined
      }));
      requestMainScrollToBottom();
    } catch (error) {
      if (abortController.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
        setWorkStatusDetail(undefined);
        setState((current) => ({
          ...current,
          mode: "planning",
          pendingReview: undefined,
          questions: [],
          error: undefined,
          logMessages: [...current.logMessages, statusLog("Plan Mode interrupted; waiting for your input")]
        }));
        requestMainScrollToBottom();
        return;
      }
      setState((current) => ({ ...current, mode: "planning", error: error instanceof Error ? error.message : String(error) }));
    } finally {
      if (planAbortControllerRef.current === abortController) planAbortControllerRef.current = undefined;
      setPlanWorkCount((current) => Math.max(0, current - 1));
    }
  };
  const cancelPendingPlanApproval = (): boolean => {
    const currentPlan = planSessionRef.current;
    if (!state.pendingReview && currentPlan?.mode !== "waiting_approval") return false;
    const nextPlan = currentPlan?.mode === "waiting_approval" ? { ...currentPlan, mode: "planning" as const } : currentPlan;
    if (nextPlan) {
      const closedMessages = closeDanglingExitPlanModeToolCalls(planMessagesRef.current, planApprovalToolResultContent({ decision: "cancel" }));
      const newMessages = planRuntimeNewMessages(planMessagesRef.current, closedMessages);
      planMessagesRef.current = closedMessages;
      appendPlanTranscriptMessages(nextPlan.sessionId, newMessages);
      planSessionRef.current = nextPlan;
      savePlanSession(nextPlan);
    }
    resetPlanApprovalFeedback();
    setState((current) => ({
      ...current,
      mode: "planning",
      planSession: nextPlan ?? current.planSession,
      pendingReview: undefined,
      error: undefined,
      logMessages: [...current.logMessages, statusLog("Plan review cancelled; waiting for your input")]
    }));
    requestMainScrollToBottom();
    return true;
  };
  const preparePlanTurn = (text: string, images: ModelContentPart[] = [], options: { logUser?: boolean; ensureUserLog?: boolean } = {}): { plan: PlanSessionState; userMessage: ModelMessage; displayText: string; ensureUserLog: boolean } | undefined => {
    let currentPlan = planSessionRef.current;
    if (!currentPlan) {
      enterGlobalPlanMode();
      currentPlan = planSessionRef.current;
    }
    if (!currentPlan) {
      failUi("Plan Mode failed to initialize");
      return;
    }
    if (currentPlan.mode === "waiting_approval") {
      return;
    }
    const displayText = text.trim() || (images.length ? "See attached image." : "");
    if (isEmptyPlanOriginalInput(currentPlan.originalInput)) {
      currentPlan = { ...currentPlan, originalInput: { request: displayText } };
      planSessionRef.current = currentPlan;
      savePlanSession(currentPlan);
    }
    const userMessage: ModelMessage = { role: "user", content: images.length ? [{ type: "text", text: displayText }, ...images] : displayText };
    if (options.logUser !== false) {
      setState((current) => appendUserLogMessage({ ...current, mode: "planning", error: undefined }, displayText));
      requestMainScrollToBottom();
    }
    return { plan: currentPlan, userMessage, displayText, ensureUserLog: options.ensureUserLog === true };
  };
  const runPreparedPlanTurn = async (turn: { plan: PlanSessionState; userMessage: ModelMessage; displayText: string; ensureUserLog: boolean }) => {
    const currentPlan = planSessionRef.current?.sessionId === turn.plan.sessionId ? planSessionRef.current : turn.plan;
    if (currentPlan?.mode === "waiting_approval") return;
    setState((current) => ({
      ...current,
      mode: "planning",
      error: undefined
    }));
    setWorkStatusDetail("Plan Mode is thinking");
    requestMainScrollToBottom();
    const messages = [...planMessagesRef.current, turn.userMessage];
    appendPlanTranscriptMessages(currentPlan.sessionId, [turn.userMessage]);
    await executePlanMessages(currentPlan, messages, { ensureUserLogText: turn.displayText });
  };
  const showHelp = () => {
    setState((current) => ({
      ...current,
      error: undefined,
      logMessages: [...current.logMessages, { ...statusLog("Help", helpDetailText()), detailVisible: true }]
    }));
    requestMainScrollToBottom();
  };
  const updateStatusline = (args: string[]) => {
    const result = parseStatuslineArgs(args, statuslineElements);
    if (result.elements) setStatuslineElements(result.elements);
    setState((current) => ({
      ...current,
      error: undefined,
      logMessages: [...current.logMessages, { ...statusLog(result.text, result.detailText), detailVisible: true }]
    }));
    requestMainScrollToBottom();
  };
  const closeCommandMenu = (message: string) => {
    setCommandMenu(undefined);
    setState((current) => ({
      ...current,
      error: undefined,
      logMessages: [...current.logMessages, statusLog(message)]
    }));
    requestMainScrollToBottom();
  };
  const toggleSkillAvailability = async (skillName: string, disabled: boolean) => {
    if (!skillRuntime || !skillConfigOptions || pendingSkillNamesRef.current.has(skillName)) return;
    const diagnostic = skillRuntime.getDiagnostics().find((skill) => skill.name === skillName);
    if (!diagnostic || diagnostic.error) return;
    pendingSkillNamesRef.current.add(skillName);
    setPendingSkillNames((current) => current.includes(skillName) ? current : [...current, skillName]);
    try {
      await setSkillDisabledState(skillConfigOptions, skillName, disabled);
      skillRuntime.setDisabledSkillNames(await loadDisabledSkillNames(skillConfigOptions));
      setSkillAvailabilityRevision((current) => current + 1);
      setState((current) => ({
        ...current,
        error: undefined,
        logMessages: [...current.logMessages, statusLog(`Skill ${disabled ? "disabled" : "enabled"}: ${skillName}`)]
      }));
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    } finally {
      pendingSkillNamesRef.current.delete(skillName);
      setPendingSkillNames((current) => current.filter((name) => name !== skillName));
    }
  };
  const runMcpAction = async (action: McpMenuAction, serverName?: string) => {
    try {
      const result = executeMcpActionForTest
        ? await executeMcpActionForTest(action, serverName)
        : await executeMcpRuntimeAction(action, serverName);
      setState((current) => ({
        ...current,
        error: undefined,
        logMessages: [...current.logMessages, { ...statusLog(result.title, result.detail), detailVisible: true }]
      }));
      requestMainScrollToBottom();
    } catch (error) {
      setState((current) => ({ ...current, error: error instanceof Error ? error.message : String(error) }));
    }
  };
  const executeMcpRuntimeAction = async (action: McpMenuAction, serverName?: string): Promise<McpActionResult> => {
    if (!mcpRuntime) throw new Error("MCP runtime is not available");
    if (action === "reconnect" && !serverName) throw new Error("Usage: /mcp reconnect <server-name>");
    const targets = serverName ? [serverName] : (collectDiagnostics?.() ?? diagnostics)?.mcp.map((server) => server.name) ?? [];
    if (!targets.length) throw new Error("No MCP servers available");
    const succeeded: string[] = [];
    const failed: string[] = [];
    for (const target of targets) {
      try {
        if (action === "disable") await setMcpServerDisabledState(requiredMcpConfigOptions(), target, true);
        if (action === "enable") await setMcpServerDisabledState(requiredMcpConfigOptions(), target, false);
        const latest = (await loadMergedMcpServersWithSourceDetails(requiredMcpConfigOptions())).find((server) => server.name === target);
        if (!latest) throw new Error(`Unknown MCP server ${target}`);
        if (action === "disable") await mcpRuntime.disconnect(target, "disabled");
        if (action === "enable") await mcpRuntime.reconnect(latest);
        if (action === "reconnect") {
          if (latest.disabled) throw new Error(`MCP server ${target} is disabled; enable it first`);
          await mcpRuntime.reconnect(latest);
        }
        succeeded.push(target);
      } catch (error) {
        failed.push(`${target}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const title = action === "enable" ? "MCP server enabled" : action === "disable" ? "MCP server disabled" : "MCP server reconnected";
    const detail = [`Succeeded: ${succeeded.join(", ") || "none"}`, failed.length ? `Failed:\n${failed.join("\n")}` : undefined].filter(Boolean).join("\n");
    if (!succeeded.length && failed.length) throw new Error(detail);
    return { title, detail };
  };
  const requiredMcpConfigOptions = (): McpConfigSourceOptions => {
    if (!mcpConfigOptions) throw new Error("MCP config options are not available");
    return mcpConfigOptions;
  };
  const enqueuePlanTurn = (text: string, images: ModelContentPart[] = [], options: { logUser?: boolean; ensureUserLog?: boolean } = {}) => {
    const turn = preparePlanTurn(text, images, options);
    if (!turn) return;
    planTurnQueueRef.current = planTurnQueueRef.current
      .catch(() => undefined)
      .then(() => runPreparedPlanTurn(turn))
      .catch((error) => failUi(error));
  };
  const approveEnterPlanModeRequest = (requestId: string) => {
    const session = sessionRef.current;
    if (session) abandonedRunIdsRef.current.add(session.runId);
    try {
      session?.permissions.resolve(requestId, "deny_once");
    } catch (error) {
      failUi(error);
      return;
    }
    void session?.interrupt().catch((error) => failUi(error));
    sessionRef.current = undefined;
    setQueued([]);
    setState((current) => ({
      ...current,
      permissionRequests: current.permissionRequests.filter((request) => request.requestId !== requestId),
      logMessages: current.logMessages.map((message) => (
        message.kind === "permission" && message.requestId === requestId
          ? { ...message, status: "allowed", text: "Entered plan mode" }
          : message
      ))
    }));
    const prompt = lastWorkflowPromptRef.current.trim();
    enterGlobalPlanMode();
    if (prompt) enqueuePlanTurn(prompt);
  };
  const continuePlanQuestion = async (answer: unknown) => {
    const currentPlan = planSessionRef.current;
    let pendingQuestion = planQuestionRef.current;
    if (!currentPlan || !pendingQuestion) {
      setState((current) => ({ ...current, mode: "running", questions: [], error: undefined }));
      await sessionRef.current?.resumeWithUserInput(answer);
      return;
    }
    const answerQuestions = questionsFromAnswer(answer);
    const visibleQuestions = questionsFromQuestion(state.questions[0]);
    const fullQuestions = answerQuestions.length > visibleQuestions.length ? answerQuestions : visibleQuestions;
    if (fullQuestions.length > pendingQuestion.questions.length) {
      pendingQuestion = { ...pendingQuestion, questions: fullQuestions };
    }
    planQuestionRef.current = undefined;
    if (isCancelQuestionAnswer(answer)) {
      const continuationMessages = planQuestionContinuationMessages(pendingQuestion.toolCallId, planQuestionCancelPayload());
      const messages = [...planMessagesRef.current, ...continuationMessages];
      resetPlanQuestionImages();
      setState((current) => ({
        ...current,
        mode: "planning",
        questions: [],
        error: undefined,
        logMessages: [...current.logMessages, statusLog("Question canceled")]
      }));
      requestMainScrollToBottom();
      appendPlanTranscriptMessages(currentPlan.sessionId, continuationMessages);
      await waitForUiTurn();
      await executePlanMessages(currentPlan, messages);
      return;
    }
    const navigation = questionNavigationDirection(answer);
    if (navigation) {
      const nextIndex = navigation === "next"
        ? Math.min(pendingQuestion.questions.length, pendingQuestion.index + 1)
        : Math.max(0, pendingQuestion.index - 1);
      planQuestionRef.current = { ...pendingQuestion, index: nextIndex };
      setState((current) => ({
        ...current,
        mode: "question",
        questions: nextIndex >= pendingQuestion.questions.length
          ? [submitQuestionReview(pendingQuestion.questions, pendingQuestion.answers)]
          : nextQuestionSlice(pendingQuestion.questions, nextIndex, pendingQuestion.answers),
        error: undefined
      }));
      return;
    }
    if (isRespondToClaudeQuestionAnswer(answer) || isFinishPlanInterviewQuestionAnswer(answer)) {
      const toolPayload = planQuestionInterviewFeedback(pendingQuestion.questions, pendingQuestion.answers, isFinishPlanInterviewQuestionAnswer(answer));
      const continuationMessages = planQuestionContinuationMessages(pendingQuestion.toolCallId, toolPayload);
      const messages = [...planMessagesRef.current, ...continuationMessages];
      resetPlanQuestionImages();
      setState((current) => ({
        ...current,
        mode: "planning",
        questions: [],
        error: undefined
      }));
      requestMainScrollToBottom();
      appendPlanTranscriptMessages(currentPlan.sessionId, continuationMessages);
      await waitForUiTurn();
      await executePlanMessages(currentPlan, messages);
      return;
    }
    if (pendingQuestion.index >= pendingQuestion.questions.length) {
      if (isSubmitQuestionAnswer(answer)) {
        const toolPayload = multiQuestionToolAnswer(pendingQuestion.answers);
        const continuationMessages = planQuestionContinuationMessages(pendingQuestion.toolCallId, toolPayload);
        const messages = [...planMessagesRef.current, ...continuationMessages];
        resetPlanQuestionImages();
        setState((current) => ({
          ...current,
          mode: "planning",
          questions: [],
          error: undefined
        }));
        requestMainScrollToBottom();
        appendPlanTranscriptMessages(currentPlan.sessionId, continuationMessages);
        await waitForUiTurn();
        await executePlanMessages(currentPlan, messages);
        return;
      }
      const previousIndex = Math.max(0, pendingQuestion.questions.length - 1);
      planQuestionRef.current = { ...pendingQuestion, index: previousIndex };
      setState((current) => ({
        ...current,
        mode: "question",
        questions: nextQuestionSlice(pendingQuestion.questions, previousIndex, pendingQuestion.answers),
        error: undefined
      }));
      return;
    }
    const text = answerText(answer);
    const answers = { ...pendingQuestion.answers, [questionText(pendingQuestion.questions[pendingQuestion.index])]: answer };
    const nextIndex = pendingQuestion.index + 1;
    if (nextIndex < pendingQuestion.questions.length) {
      planQuestionRef.current = { ...pendingQuestion, index: nextIndex, answers };
      setState((current) => appendUserLogMessage({
        ...current,
        mode: "question",
        questions: nextQuestionSlice(pendingQuestion.questions, nextIndex, answers),
        error: undefined
      }, text));
      requestMainScrollToBottom();
      return;
    }
    if (pendingQuestion.questions.length > 1) {
      planQuestionRef.current = { ...pendingQuestion, index: nextIndex, answers };
      setState((current) => appendUserLogMessage({
        ...current,
        mode: "question",
        questions: [submitQuestionReview(pendingQuestion.questions, answers)],
        error: undefined
      }, text));
      requestMainScrollToBottom();
      return;
    }
    const toolPayload = multiQuestionToolAnswer(answers);
    const continuationMessages = planQuestionContinuationMessages(pendingQuestion.toolCallId, toolPayload);
    const messages = [...planMessagesRef.current, ...continuationMessages];
    resetPlanQuestionImages();
    setState((current) => appendUserLogMessage({ ...current, mode: "planning", questions: [], error: undefined }, text));
    requestMainScrollToBottom();
    appendPlanTranscriptMessages(currentPlan.sessionId, continuationMessages);
    await waitForUiTurn();
    await executePlanMessages(currentPlan, messages, { ensureUserLogText: text });
  };

  const showCurrentPlan = async () => {
    const currentPlan = planSessionRef.current;
    if (!currentPlan) {
      enterGlobalPlanMode();
      return;
    }
    try {
      const document = (await readPlan(currentPlan.planFilePath))?.trim();
      if (!document) {
        setState((current) => ({
          ...current,
          mode: "planning",
          error: undefined,
          conversation: [...current.conversation, { kind: "status", text: "Already in plan mode. No plan written yet." }],
          logMessages: [...current.logMessages, statusLog("Already in plan mode. No plan written yet.", currentPlan.planFilePath)]
        }));
        return;
      }
      const editorName = externalEditorDisplayName();
      const editorHint = editorName ? `\n\n"/plan open" to edit this plan in ${editorName}` : "";
      const displayPath = displayPlanFilePath(currentPlan.planFilePath, cwd);
      setState((current) => {
        const currentPlanLog = { ...statusLog("Current Plan", `${displayPath}\n\n${document}${editorHint}`), detailVisible: true };
        return {
          ...current,
          mode: "planning",
          error: undefined,
          conversation: [...current.conversation, { kind: "status", text: "Current Plan", detailText: document }],
          logMessages: [...current.logMessages, currentPlanLog]
        };
      });
    } catch (error) {
      failUi(error);
    }
  };

  const openCurrentPlan = async () => {
    const currentPlan = planSessionRef.current;
    if (!currentPlan) return;
    try {
      const document = (await readPlan(currentPlan.planFilePath))?.trim();
      if (!document) {
        await showCurrentPlan();
        return;
      }
      const edited = await editPlanFile(currentPlan.planFilePath);
      if (edited.error) {
        setState((current) => ({ ...current, error: edited.error }));
        return;
      }
      setState((current) => ({
        ...current,
        error: undefined,
        logMessages: [...current.logMessages, statusLog("Opened plan in editor", currentPlan.planFilePath)]
      }));
      requestMainScrollToBottom();
    } catch (error) {
      failUi(error);
    }
  };

  const refreshPendingPlanReview = async (options: { openEditor?: boolean } = {}) => {
    const review = state.pendingReview;
    const planFilePath = review?.planFilePath;
    if (!review || !planFilePath) return;
    try {
      const edited = options.openEditor ? await editPlanFile(planFilePath) : undefined;
      if (edited?.error) {
        setState((current) => ({ ...current, error: edited.error }));
      }
      const document = (await readPlan(planFilePath))?.trim() ?? "";
      const empty = !document;
      const savedMessage = edited && edited.content !== null ? "✓Plan saved!" : review.savedMessage;
      setState((current) => ({
        ...current,
        pendingReview: current.pendingReview
          ? { ...current.pendingReview, document, empty, savedMessage }
          : current.pendingReview,
        error: undefined,
        logMessages: current.logMessages.map((message) => (
          message.kind === "plan" && message.nodeId === review.nodeId && message.attempt === review.attempt && message.status === "pending"
            ? globalPlanLog(document, planFilePath, review.requestedPermissions, empty)
            : message
        ))
      }));
      requestMainScrollToBottom();
    } catch (error) {
      failUi(error);
    }
  };

  const showPendingPlanReview = async () => {
    const review = state.pendingReview;
    const planFilePath = review?.planFilePath;
    if (!review || !planFilePath) return;
    try {
      const document = (await readPlan(planFilePath))?.trim() ?? review.document.trim();
      if (!document) {
        setState((current) => ({
          ...current,
          error: undefined,
          logMessages: [...current.logMessages, statusLog("Already in plan mode. No plan written yet.", planFilePath)]
        }));
        requestMainScrollToBottom();
        return;
      }
      const editorName = externalEditorDisplayName();
      const editorHint = editorName ? `\n\n"/plan open" to edit this plan in ${editorName}` : "";
      const displayPath = displayPlanFilePath(planFilePath, cwd);
      setState((current) => ({
        ...current,
        error: undefined,
        pendingReview: current.pendingReview
          ? { ...current.pendingReview, document, empty: false }
          : current.pendingReview,
        logMessages: [...current.logMessages, { ...statusLog("Current Plan", `${displayPath}\n\n${document}${editorHint}`), detailVisible: true }]
      }));
      requestMainScrollToBottom();
    } catch (error) {
      failUi(error);
    }
  };
  const resolveGlobalPlan = async (decision: "continue" | "stay", mode: PermissionMode = state.defaultExecutionMode, feedback?: unknown, options: { clearContext?: boolean } = {}): Promise<boolean> => {
    const currentPlan = planSessionRef.current;
    const document = state.pendingReview?.document ?? "";
    if (!currentPlan) return false;
    const controller = new PlanModeController();
    const kernelSession = planApprovalKernelSession({
      cwd,
      plan: currentPlan,
      document,
      messages: planMessagesRef.current,
      review: state.pendingReview,
      defaultExecutionMode: state.defaultExecutionMode
    });
    if (decision === "stay") {
      const resolved = (await controller.resolvePlanApproval(kernelSession, { decision: "stay", feedback })).session;
      const nextPlan = resolved.planState!;
      const rejectionMessage = planRejectionMessage(document, feedback);
      const review = state.pendingReview;
      const feedbackDetail = feedbackText(feedback);
      const rejectedDocument = feedbackDetail
        ? `${document.trim() || "Einstein wants to exit plan mode"}

User feedback:
${feedbackDetail}`
        : document;
      const resolvedMessages = planRuntimeNewMessages(planMessagesRef.current, resolved.messages);
      planSessionRef.current = nextPlan;
      planMessagesRef.current = [...resolved.messages, rejectionMessage];
      appendPlanTranscriptMessages(nextPlan.sessionId, [...resolvedMessages, rejectionMessage]);
      savePlanSession(nextPlan);
      resetPlanApprovalFeedback();
      setState((current) => {
        const rejectedLogs = [
          ...current.logMessages.map((message) => (
            review && message.kind === "plan" && message.nodeId === review.nodeId && message.attempt === review.attempt && message.status === "pending"
              ? { ...message, status: "rejected" as const, document: rejectedDocument, detailText: feedbackDetail ? `Plan Mode rejected.
User feedback: ${feedbackDetail}` : `Plan Mode rejected.${message.detailText ? `
${message.detailText}` : ""}` }
              : message
          )),
          ...(feedbackDetail ? [{ id: randomUUID(), kind: "user" as const, text: feedbackDetail }] : []),
          statusLog("Plan Mode rejected; keep planning", feedbackDetail)
        ];
        return {
          ...current,
          mode: "planning",
          planSession: nextPlan,
          pendingReview: undefined,
          error: undefined,
          logMessages: rejectedLogs
        };
      });
      requestMainScrollToBottom();
      void executePlanMessages(nextPlan, planMessagesRef.current).catch((error) => failUi(error));
      return true;
    }
    const resolved = await controller.resolvePlanApproval(kernelSession, {
      decision: "continue",
      permissionMode: mode === "plan" ? "default" : mode,
      clearContext: options.clearContext === true,
      feedback: feedbackText(feedback)
    });
    const nextPlan = resolved.session.planState!;
    const resolvedMessages = planRuntimeNewMessages(planMessagesRef.current, resolved.session.messages);
    planSessionRef.current = nextPlan;
    planMessagesRef.current = resolved.session.messages;
    appendPlanTranscriptMessages(nextPlan.sessionId, resolvedMessages);
    savePlanSession(nextPlan);
    resetPlanApprovalFeedback();
    const execution = resolved.execution;
    setState((current) => ({ ...current, mode: "running", inputPermissionMode: execution?.permissionMode ?? current.inputPermissionMode, planSession: nextPlan, pendingReview: undefined, error: undefined }));
    if (!execution) return true;
    const handoff = execution.handoff as { legacyHandoff?: unknown };
    const workflowInput = execution.clearContext ? execution.initialInput : handoff.legacyHandoff;
    void startWorkflowInput(workflowInput, {
      permissionMode: execution.permissionMode,
      inputPermissionMode: execution.permissionMode,
      preserveLogs: true,
      sessionId: nextPlan.sessionId,
      ...(execution.clearContext ? { clearContext: true } : {})
    });
    return true;
  };
  const clearTuiContext = () => {
    setQueued([]);
    setState((current) => ({
      ...initialTuiState({ cwd: current.cwd, inputPermissionMode: current.inputPermissionMode }),
      workflowId: current.workflowId,
      runId: current.runId,
      mode: current.mode === "planning" || current.mode === "waiting_plan_approval" ? current.mode : "input",
      planSession: current.planSession,
      sessionUsage: current.sessionUsage,
      modelRequestCount: current.modelRequestCount,
      pendingReview: current.mode === "waiting_plan_approval" ? current.pendingReview : undefined,
      error: undefined
    }));
  };
  const restorePlanSession = async (sessionId: string) => {
    const metadata = await sessionStore.loadMetadata(sessionId);
    currentSessionIdRef.current = sessionId;
    sessionAuditGenerationRef.current += 1;
    const transcript = await sessionStore.loadTranscript(sessionId);
    const planTranscript = transcript.filter((entry) => entry.phase !== "workflow");
    let plan = metadata?.plan;
    if (!plan) {
      plan = await recoverMissingPlanSession({
        sessionId,
        cwd,
        planFilePath: join(sessionStore.sessionDir(sessionId), "plans", "plan.md"),
        messages: planTranscript.map((entry) => entry.message)
      });
      if (plan) savePlanSession(plan);
    }
    if (!plan) {
      if (metadata?.currentRunId) {
        await resumeRun(metadata.currentRunId);
        return;
      }
      setState((current) => ({ ...current, mode: "input", error: `Session ${sessionId} has no resumable state` }));
      return;
    }

    planSessionRef.current = plan;
    planMessagesRef.current = planTranscript.map((entry) => entry.message);
    const transcriptLogs = planLogMessagesFromTranscript(planMessagesRef.current);
    const base = (current: TuiState) => ({
      ...initialTuiState({ cwd: current.cwd, inputPermissionMode: current.inputPermissionMode }),
      workflowId: current.workflowId ?? selectedWorkflowId,
      sessionUsage: metadata?.usage ?? emptyModelUsage(),
      modelRequestCount: metadata?.modelRequestCount ?? 0,
      planSession: plan,
      error: undefined
    });

    if (plan.mode === "waiting_approval") {
      const document = (await readPlanOrRecoverFromTranscript({ planFilePath: plan.planFilePath, cwd, messages: planMessagesRef.current }))?.trim() ?? plan.approvedPlan ?? "";
      const empty = !document.trim();
      if (empty) {
        const resumedPlan: PlanSessionState = { ...plan, mode: "planning" };
        planSessionRef.current = resumedPlan;
        savePlanSession(resumedPlan);
        setState((current) => ({
          ...base(current),
          mode: "planning",
          planSession: resumedPlan,
          logMessages: [statusLog("Plan Mode restored", plan.planFilePath), ...transcriptLogs, statusLog("Plan file is empty; keep planning", plan.planFilePath)]
        }));
        return;
      }
      setState((current) => ({
        ...base(current),
        mode: "waiting_plan_approval",
        pendingReview: { type: "plan", nodeId: "global-plan", attempt: 1, document, planFilePath: plan.planFilePath, empty, requestedPermissions: plan.requestedPermissions, toolCallId: plan.approvalToolCallId },
        logMessages: [statusLog("Plan Mode restored", plan.planFilePath), ...transcriptLogs, globalPlanLog(document, plan.planFilePath, plan.requestedPermissions, empty)]
      }));
      return;
    }

    if (plan.mode === "planning") {
      setState((current) => ({
        ...base(current),
        mode: "planning",
        logMessages: [statusLog("Plan Mode restored", plan.planFilePath), ...transcriptLogs]
      }));
      return;
    }

    if (metadata?.currentRunId) await resumeRun(metadata.currentRunId);
    else setState((current) => ({ ...current, mode: "input", error: `Session ${sessionId} is not waiting for resume` }));
  };
  const resumeById = async (id: string) => {
    if (id.startsWith("run:")) {
      await resumeRun(id.slice("run:".length));
      return;
    }
    if (id.startsWith("session:")) {
      await restorePlanSession(id.slice("session:".length));
      return;
    }
    const metadata = await sessionStore.loadMetadata(id);
    if (metadata?.plan || metadata?.currentRunId) await restorePlanSession(id);
    else await resumeRun(id);
  };

  const openResumePicker = async () => {
    try {
      const runs = engine ? await engine.listRuns({ limit: 30 }) : [];
      const runById = new Map(runs.map((run) => [run.runId, run]));
      const sessions = await sessionStore.listSessions({ limit: 30 });
      const sessionEntries = (await Promise.all(sessions.map(async (metadata) => {
        let plan = metadata.plan;
        if (!plan && !metadata.currentRunId) {
          const transcript = await sessionStore.loadTranscript(metadata.sessionId).catch(() => []);
          plan = await recoverMissingPlanSession({
            sessionId: metadata.sessionId,
            cwd,
            planFilePath: join(sessionStore.sessionDir(metadata.sessionId), "plans", "plan.md"),
            messages: transcript.filter((item) => item.phase !== "workflow").map((item) => item.message)
          });
          if (plan) savePlanSession(plan);
        }
        const run = metadata.currentRunId ? runById.get(metadata.currentRunId) : undefined;
        return {
          kind: "session" as const,
          id: `session:${metadata.sessionId}`,
          sessionId: metadata.sessionId,
          status: plan?.mode ?? run?.status ?? "session",
          workflowRunId: metadata.currentRunId,
          updatedAt: metadata.lastActivityAt,
          inputPreview: plan ? inputPreview(plan.originalInput) : metadata.inputPreview ?? run?.inputPreview ?? metadata.currentRunId ?? metadata.sessionId,
          planMode: plan?.mode
        };
      }))).filter((entry) => entry.planMode === "planning" || entry.planMode === "waiting_approval" || entry.workflowRunId);
      const linkedRunIds = new Set(sessionEntries.flatMap((entry) => entry.workflowRunId ? [entry.workflowRunId] : []));
      const orphanRunEntries = runs
        .filter((run) => !linkedRunIds.has(run.runId))
        .map((run) => ({ ...run, kind: "run" as const, id: `run:${run.runId}` }));
      const resumeRuns = [...sessionEntries, ...orphanRunEntries]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.id.localeCompare(left.id))
        .slice(0, 30);
      if (!resumeRuns.length) {
        setState((current) => ({ ...current, mode: "input", resumeRuns: [], error: "No sessions found" }));
        return;
      }
      setState((current) => ({ ...current, mode: "resume_picker", resumeRuns, error: undefined }));
    } catch (error) {
      failUi(error);
    }
  };
  const dispatchInjectedPrompt = (content: string) => {
    if (state.pendingReview || state.mode === "permission" || state.mode.startsWith("confirm_") || state.mode === "resume_picker" || state.mode === "select_workflow") {
      throw new Error(`Cannot inject a prompt while ${state.mode}`);
    }
    if (state.mode === "planning" || (state.mode === "input" && state.inputPermissionMode === "plan") || isPlanSessionAcceptingInput(planSessionRef.current)) {
      enqueuePlanTurn(content);
    } else if ((state.mode === "paused" || state.mode === "interrupted") && state.runId) {
      resumeSession(content);
    } else if (state.runId || state.mode === "completed" || state.mode === "failed") {
      void continueSession(content).catch((error) => failUi(error));
    } else {
      void startRun(content);
    }
  };
  const runMcpPromptCommand = async (commandName: string, args: string[]) => {
    try {
      if (!mcpRuntime) throw new Error("MCP runtime is not available");
      const command = mcpRuntime.listPromptCommands().find((candidate) => candidate.name === commandName);
      if (!command) throw new Error(`Unknown MCP prompt command ${commandName}`);
      const prompt = (await mcpRuntime.listPrompts({ server: command.server })).find((candidate) => candidate.name === command.prompt);
      const named = Object.fromEntries(args.filter((arg) => arg.includes("=")).map((arg) => { const index = arg.indexOf("="); return [arg.slice(0, index), arg.slice(index + 1)]; }));
      const positional = args.filter((arg) => !arg.includes("="));
      const promptArgs = Object.fromEntries((prompt?.arguments ?? []).flatMap((argument, index) => {
        const value = named[argument.name] ?? positional[index];
        if (value === undefined && argument.required) throw new Error(`Missing required MCP prompt argument ${argument.name}`);
        return value === undefined ? [] : [[argument.name, value]];
      }));
      const result = await mcpRuntime.getPrompt(command.server, command.prompt, promptArgs);
      const content = result.messages.map((message) => {
        const body = message.content.type === "text" && typeof message.content.text === "string" ? message.content.text : JSON.stringify(message.content);
        return `${message.role}: ${body}`;
      }).join("\n\n");
      setState((current) => ({ ...current, logMessages: [...current.logMessages, statusLog(`MCP prompt: ${command.server}/${command.prompt}`)], error: undefined }));
      dispatchInjectedPrompt(content);
    } catch (error) {
      failUi(error);
    }
  };
  const runUserSkillCommand = async (name: string, args: string[]) => {
    try {
      if (!skillRuntime) throw new Error("Skill runtime is not available");
      const skill = skillRuntime.getSkill(name);
      if (!skill || skill.userInvocable === false) throw new Error(`Unknown user-invocable skill ${name}`);
      const providerSelection = selectPlanProvider({ config, workflowId: selectedWorkflowId ?? state.workflowId, providerFactory });
      const tools = createLocalToolRegistry({ mcpRuntime, skillRuntime });
      const activation = await skillRuntime.activateSkill(name, {
        args: args.join(" "),
        prompt: args.join(" "),
        cwd,
        sessionId: planSessionRef.current?.sessionId ?? state.runId ?? `skill-${name}`,
        provider: providerSelection?.provider,
        model: providerSelection?.model,
        tools,
        parentPermissionMode: state.inputPermissionMode
      });
      const content = activation.mode === "inline" ? activation.renderedPrompt : activation.output;
      setState((current) => ({ ...current, logMessages: [...current.logMessages, statusLog(`Skill activated: ${name}`)], error: undefined }));
      dispatchInjectedPrompt(content);
    } catch (error) {
      failUi(error);
    }
  };
  const handlePromptEvent = (event: PromptInputEvent) => {
    if (event.type === "cancel") {
      cancelActiveChoice();
      return;
    }
    if (event.type === "queue") {
      const hasPlanQuestion = Boolean(planQuestionRef.current) || state.questions.length > 0;
      if (!hasPlanQuestion && (state.mode === "planning" || (state.mode === "input" && state.inputPermissionMode === "plan") || (state.mode !== "question" && isPlanSessionAcceptingInput(planSessionRef.current)))) {
        enqueuePlanTurn(event.text, event.images);
        return;
      }
      setQueued((current) => [...current, { text: event.text, images: event.images ?? [] }]);
      setState((current) => ({ ...current, timeline: [...current.timeline, `queued:${event.text}`] }));
      return;
    }
    if (event.type === "cycle_mode") {
      if (state.pendingReview) {
        const approval = planApprovalFastAccept(
          state.pendingReview.empty === true || !state.pendingReview.document.trim(),
          settings?.showClearContextOnPlanAccept === true,
          state.defaultExecutionMode === "fullAccess"
        );
        void resolveGlobalPlan("continue", approval.permissionMode, planApprovalAcceptFeedback(), { clearContext: approval.clearContext });
      } else if (state.mode === "input") {
        setState((current) => {
          const nextMode = nextInputPermissionMode(current.inputPermissionMode, current.defaultExecutionMode);
          return {
            ...current,
            inputPermissionMode: nextMode,
            error: undefined,
            logMessages: [...current.logMessages, statusLog(`Permission mode: ${permissionModeLabel(nextMode)}`)]
          };
        });
      }
      else if (state.mode === "planning" || state.mode === "waiting_plan_approval") setState((current) => ({ ...current, error: "Plan Mode is already active" }));
      return;
    }
    if (event.type === "external_editor") {
      if (state.pendingReview) void refreshPendingPlanReview({ openEditor: true });
      return;
    }
    if (event.type === "external_editor_error") {
      setState((current) => ({ ...current, error: event.error }));
      return;
    }
    if (event.type === "command") {
      if (event.name === "skills") {
        if (event.args[0] === "refresh") {
          void skillRuntime?.refresh().then(() => {
            setState((current) => ({ ...current, error: undefined, logMessages: [...current.logMessages, statusLog("Skills refreshed")] }));
            setCommandMenu({ kind: "skills:list" });
          }).catch((error) => failUi(error));
        } else {
          setCommandMenu({ kind: "skills:list" });
        }
        return;
      }
      const mcpPromptCommand = mcpRuntime?.listPromptCommands().find((command) => command.name === event.name);
      if (mcpPromptCommand) {
        void runMcpPromptCommand(event.name, event.args);
        return;
      }
      const invokedSkill = skillRuntime?.getSkill(event.name);
      if (invokedSkill && invokedSkill.userInvocable !== false) {
        void runUserSkillCommand(event.name, event.args);
        return;
      }
      if (event.name === "mcp") {
        const action = event.args[0];
        if (action === "enable" || action === "disable" || action === "reconnect") void runMcpAction(action, event.args.slice(1).join(" ") || undefined);
        else setCommandMenu({ kind: "mcp:list" });
        return;
      }
      if (event.name === "help") {
        showHelp();
      }
      if (event.name === "statusline") {
        if (event.args.length) updateStatusline(event.args);
        else setCommandMenu({ kind: "statusline" });
      }
      if (event.name === "new") {
        if (isActiveSessionMode(state.mode)) setState((current) => ({ ...current, mode: "confirm_new", modeBeforeConfirmation: current.mode }));
        else resetSession();
      }
      if (event.name === "plan") {
        const description = event.args.join(" ").trim();
        const openPlan = event.args[0] === "open";
        const currentPlanMode = planSessionRef.current?.mode;
        const inPendingPlanApproval = state.mode === "waiting_plan_approval" || Boolean(state.pendingReview) || currentPlanMode === "waiting_approval";
        const inActivePlanMode = state.mode === "planning" || isPlanSessionAcceptingInput(planSessionRef.current);
        if (inPendingPlanApproval) {
          if (openPlan) void refreshPendingPlanReview({ openEditor: true });
          else void showPendingPlanReview();
        } else if (inActivePlanMode) {
          if (openPlan) void openCurrentPlan();
          else void showCurrentPlan();
        } else {
          enterGlobalPlanMode();
          if (description && description !== "open") enqueuePlanTurn(description);
        }
      }
      if (event.name === "clear") {
        clearTuiContext();
      }
      if (event.name === "permissions") {
        setState((current) => ({ ...current, mode: "permissions", modeBeforeConfirmation: current.mode, error: undefined }));
      }
      if (event.name === "resume") {
        const runId = event.args[0];
        if (isActiveSessionMode(state.mode)) setState((current) => ({ ...current, mode: "confirm_resume", pendingResumeRunId: runId, modeBeforeConfirmation: current.mode }));
        else if (runId) void resumeById(runId);
        else void openResumePicker();
      }
      return;
    }
    if (state.pendingReview) {
      if (event.text.trim()) {
        const feedback = planApprovalPromptFeedback(event.text);
        void resolveGlobalPlan("stay", "default", feedback);
      }
      return;
    }
    if (planQuestionRef.current || state.mode === "question") {
      if (planQuestionRef.current) void continuePlanQuestion(freeformQuestionAnswer(nextQuestionSlice(planQuestionRef.current.questions, planQuestionRef.current.index), event.text)).catch((error) => failUi(error));
      else resumeSession(event.text);
      return;
    }
    if (state.mode === "planning" || (state.mode === "input" && state.inputPermissionMode === "plan") || isPlanSessionAcceptingInput(planSessionRef.current)) {
      enqueuePlanTurn(event.text, event.images);
      return;
    }
    if (state.mode === "permission" || state.mode === "confirm_interrupt" || state.mode === "confirm_new" || state.mode === "confirm_resume" || state.mode === "resume_picker" || state.mode === "select_workflow") return;
    if ((state.mode === "paused" || state.mode === "interrupted") && state.runId) {
      resumeSession(event.text);
      return;
    }
    if (state.runId || state.mode === "completed" || state.mode === "failed") {
      void continueSession(event.text, event.images ?? []).catch((error) => failUi(error));
      return;
    }
    void startRun(event.text, event.images ?? []);
  };
  const displayedWorkflowId = state.mode === "select_workflow" ? previewWorkflowId : selectedWorkflowId;
  const workflowNodes = displayedWorkflowId
    ? config?.workflows[displayedWorkflowId]?.nodes.map((node) => {
      const provider = config.providers[node.provider];
      const role = config.roles[node.role];
      const registry = modelRegistryFromProviderConfig(provider);
      const configuredModel = resolveModelForWorkflowNode({ node, role, provider, permissionMode: node.permission_mode, planModel: provider.plan_model, registry });
      const runtimeModel = [...state.nodes].reverse().find((item) => item.nodeId === node.id)?.model;
      const model = runtimeModel ?? configuredModel;
      return {
        id: node.id,
        role: node.role,
        model,
        effort: resolveEffortForWorkflowNode({ node, provider }),
        contextLimit: getModelContextLimits(model, registry, getProviderMaxOutputTokens(provider)).autoCompactLimit
      };
    })
    : undefined;
  const hasPlanQuestion = Boolean(planQuestionRef.current) || state.questions.length > 0;
  const interactionMode = state.pendingReview && !isConfirmationMode(state.mode) ? "waiting_plan_approval" : hasPlanQuestion ? "question" : state.mode;
  const planApprovalActive = interactionMode === "waiting_plan_approval" && Boolean(state.pendingReview);
  const planApprovalOverlayVisible = planApprovalActive && !planApprovalCollapsed;
  const planApprovalPlanFilePath = state.pendingReview?.planFilePath ? displayPlanFilePath(state.pendingReview.planFilePath, cwd) : undefined;
  const logMessages = state.logMessages;
  const rawActivityStatus = activityStatusText({ isWorking, workStartedAtMs, lastWorkDurationMs, nowMs: clockMs, detail: workStatusDetail });
  const activityStatus = hasPlanQuestion || state.pendingReview ? undefined : rawActivityStatus;
  const currentDiagnosticsForMenu = collectDiagnostics?.() ?? diagnostics ?? { mcp: [], skills: [] };
  const commandMenuChoice = commandMenu ? buildCommandMenuChoice({
    state: commandMenu,
    diagnostics: currentDiagnosticsForMenu,
    mcpRuntime,
    statuslineElements,
    setStatuslineElements,
    setCommandMenu,
    closeCommandMenu,
    runMcpAction,
    pendingSkillNames,
    toggleSkillAvailability
  }) : undefined;
  const activeChoice = commandMenuChoice ?? buildActiveChoice({
    mode: interactionMode,
    workflows,
    workflowConfigs: config?.workflows,
    previewWorkflowId,
    previewWorkflow: (workflow) => {
      if (config?.workflows[workflow]) setPreviewWorkflowId(workflow);
    },
    permission: state.permissionRequests[0],
    review: state.pendingReview,
    questions: state.questions,
    isPlanQuestion: Boolean(planQuestionRef.current),
    planFilePath: planQuestionRef.current && planSessionRef.current?.planFilePath ? displayPlanFilePath(planSessionRef.current.planFilePath, cwd) : undefined,
    planApprovalPlanFilePath,
    planApprovalChoiceOnly: planApprovalActive,
    planApprovalEditorName: state.pendingReview ? externalEditorDisplayName() : undefined,
    showClearContextOnPlanAccept: settings?.showClearContextOnPlanAccept === true,
    contextUsedPercent: state.pendingReview?.contextUsedPercent,
    isFullAccessModeAvailable: state.defaultExecutionMode === "fullAccess",
    defaultExecutionMode: state.defaultExecutionMode,
    selectWorkflow,
    resolvePermission: (requestId, decision) => {
      const request = state.permissionRequests.find((item) => item.requestId === requestId);
      if (request?.tool === "EnterPlanMode" && decision === "allow_once") {
        approveEnterPlanModeRequest(requestId);
        return;
      }
      try {
        sessionRef.current?.permissions.resolve(requestId, decision);
      } catch (error) {
        failUi(error);
      }
    },
    resolvePlan: (decision, mode, feedbackOverride, options) => {
      if (!state.pendingReview) return;
      const feedback = feedbackOverride ?? planApprovalFeedbackPayload();
      void resolveGlobalPlan(decision, mode, feedback, options);
    },
    cancelPlanApproval: cancelPendingPlanApproval,
    planApprovalPromptFeedback,
    planApprovalAcceptFeedback,
    updatePlanApprovalFeedback: (text) => {
      planApprovalFeedbackRef.current = text;
    },
    hasPlanApprovalFeedback,
    planApprovalImages,
    addPlanApprovalImage,
    removePlanApprovalImage,
    resolvePlanApprovalImagePaste,
    planQuestionImages,
    addPlanQuestionImage,
    removePlanQuestionImage,
    resolvePlanQuestionImagePaste,
    resolveQuestion: (answer) => {
      if (planQuestionRef.current) void continuePlanQuestion(answer).catch((error) => failUi(error));
      else {
        setState((current) => ({ ...current, mode: "running", questions: [], error: undefined }));
        void sessionRef.current?.resumeWithUserInput(answer).catch((error) => failUi(error));
      }
    },
    editQuestionText,
    resolveInterrupt: (decision) => {
      if (decision === "interrupt") interruptAndExit();
      else setState((current) => ({ ...current, mode: current.modeBeforeConfirmation ?? "running", modeBeforeConfirmation: undefined }));
    },
    resumeRuns: state.resumeRuns,
    resolveResume: (runId) => {
      setState((current) => ({ ...current, mode: "input", resumeRuns: [], error: undefined, pendingResumeRunId: undefined, modeBeforeConfirmation: undefined }));
      void resumeById(runId);
    },
    resolveNew: (decision) => {
      if (decision === "new") {
        void sessionRef.current?.interrupt().finally(() => resetSession());
      } else {
        setState((current) => ({ ...current, mode: current.modeBeforeConfirmation ?? "running", modeBeforeConfirmation: undefined }));
      }
    },
    resolvePendingResume: (decision) => {
      const runId = state.pendingResumeRunId;
      if (decision === "resume") {
        void sessionRef.current?.interrupt().finally(() => {
          if (runId) void resumeRun(runId);
          else void openResumePicker();
        });
      } else {
        setState((current) => ({ ...current, mode: current.modeBeforeConfirmation ?? "running", pendingResumeRunId: undefined, modeBeforeConfirmation: undefined }));
      }
    },
    resolveDefaultExecutionMode: (mode) => {
      const persistence = !saveDefaultPermissionMode || mode === state.defaultExecutionMode
        ? Promise.resolve()
        : saveDefaultPermissionMode(mode);
      void persistence.then(() => {
        if (saveDefaultPermissionMode) persistedDefaultExecutionModeRef.current = mode;
        setState((current) => {
          const nextMode = current.modeBeforeConfirmation && current.modeBeforeConfirmation !== "permissions"
            ? current.modeBeforeConfirmation
            : "input";
          return {
            ...current,
            mode: nextMode,
            modeBeforeConfirmation: undefined,
            defaultExecutionMode: mode,
            inputPermissionMode: current.inputPermissionMode === "plan" ? "plan" : mode,
            error: undefined,
            logMessages: [...current.logMessages, statusLog(`Permission mode: ${permissionModeLabel(mode)}`)]
          };
        });
      }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setState((current) => ({ ...current, error: `Failed to save permission mode: ${message}` }));
      });
    }
  });
  const nextChoiceKey = activeChoice ? `${interactionMode}:${activeChoice.title}:${activeChoice.options.map((option) => option.value).join("|")}` : "";
  const cancelActiveChoice = (): boolean => {
    const action = resolveActiveChoiceCancel({ ...state, mode: interactionMode });
    if (action.type === "none") return false;
    if (canceledChoiceKeyRef.current === action.key) return true;
    canceledChoiceKeyRef.current = action.key;
    if (action.type === "exit") {
      exitTui();
      return true;
    }
    if (action.type === "restore_mode") {
      setState((current) => ({
        ...current,
        mode: action.mode,
        pendingResumeRunId: action.clearPendingResumeRunId ? undefined : current.pendingResumeRunId,
        resumeRuns: action.clearResumePicker ? [] : current.resumeRuns,
        error: action.clearResumePicker ? undefined : current.error,
        modeBeforeConfirmation: undefined
      }));
      return true;
    }
    if (action.type === "deny_permission") {
      try {
        sessionRef.current?.permissions.resolve(action.requestId, "deny_once");
      } catch (error) {
        failUi(error);
      }
      return true;
    }
    if (action.type === "cancel_plan_approval") return cancelPendingPlanApproval();
    return true;
  };
  const interruptActiveWork = (): boolean => {
    if (planAbortControllerRef.current || planWorkCount > 0) {
      planAbortControllerRef.current?.abort();
      return true;
    }
    if (state.mode === "running" && sessionRef.current) {
      void sessionRef.current.interrupt().catch((error) => failUi(error));
      setState((current) => ({ ...current, mode: "interrupted", error: undefined }));
      return true;
    }
    return false;
  };
  const cancelCurrentInteraction = (): boolean => {
    if (activeChoice?.onCancel) {
      activeChoice.onCancel();
      return true;
    }
    return cancelActiveChoice();
  };
  useEffect(() => {
    if (choiceKey === nextChoiceKey) return;
    setChoiceKey(nextChoiceKey);
    canceledChoiceKeyRef.current = undefined;
  }, [choiceKey, nextChoiceKey]);
  useEffect(() => {
    const handleEscapeData = (value: unknown) => {
      const text = typeof value === "string" ? value : Buffer.isBuffer(value) ? value.toString("utf8") : "";
      if (text !== "" || transcriptMode) return;
      if (selection.hasSelection()) {
        selection.clearSelection();
        selectionEscapeConsumedRef.current = true;
        return;
      }
      if (!cancelCurrentInteraction()) interruptActiveWork();
    };
    stdin.on?.("data", handleEscapeData);
    return () => {
      stdin.off?.("data", handleEscapeData);
    };
  }, [stdin, cancelCurrentInteraction, transcriptMode, selection]);
  const halfScreenChoice = activeChoice?.placement === "half-screen";
  const layout = layoutMetrics({
    terminalRows,
    choice: halfScreenChoice ? undefined : activeChoice,
    activityStatusVisible: Boolean(activityStatus && !activeChoice)
  });
  const planApprovalDocumentMaxLines = state.pendingReview ? planApprovalOverlayMaxDocumentLines(state.pendingReview, layout.mainHeight) : 0;
  const scrollPlanApprovalDocument = (delta: number): boolean => {
    const review = state.pendingReview;
    if (!review || !planApprovalOverlayVisible) return false;
    const lineCount = planApprovalOverlayDocument(review).split(/\r?\n/).length;
    const maxOffset = Math.max(0, lineCount - planApprovalDocumentMaxLines);
    if (maxOffset <= 0) return false;
    setPlanApprovalDocumentOffset((current) => Math.max(0, Math.min(maxOffset, current + delta)));
    return true;
  };
  useEffect(() => {
    if (planApprovalOverlayVisible) mainScrollRef.current?.scrollTo(0);
  }, [planApprovalOverlayVisible, state.pendingReview?.document, state.pendingReview?.planFilePath]);
  useInput((input, key, event) => {
    if (key.escape && selectionEscapeConsumedRef.current) {
      selectionEscapeConsumedRef.current = false;
      event.stopImmediatePropagation();
      return;
    }

    const isCommandCopy = key.super && event.keypress.name === "c";
    const isCtrlShiftCopy = key.ctrl && key.shift && event.keypress.name === "c";
    if (isCommandCopy || isCtrlShiftCopy) {
      if (selection.hasSelection()) selection.copySelection();
      event.stopImmediatePropagation();
      return;
    }

    if (selection.hasSelection()) {
      if (key.escape) {
        selection.clearSelection();
        event.stopImmediatePropagation();
        return;
      }
      if (key.ctrl && !key.shift && !key.meta && input === "c") {
        selection.copySelection();
        event.stopImmediatePropagation();
        return;
      }

      const isNavigation =
        key.leftArrow ||
        key.rightArrow ||
        key.upArrow ||
        key.downArrow ||
        key.home ||
        key.end ||
        key.pageUp ||
        key.pageDown;
      const preservesSelection = isNavigation && (key.shift || key.meta || key.super);
      if (key.wheelUp || key.wheelDown || !preservesSelection) selection.clearSelection();
    }

    if (planApprovalActive && isPlanApprovalToggleInput(input) && !key.ctrl && !key.meta) {
      setPlanApprovalCollapsed((current) => !current);
      event.stopImmediatePropagation();
      return;
    }
    if (planApprovalActive && (input === "\u0007" || (key.ctrl && input === "g"))) {
      void refreshPendingPlanReview({ openEditor: true });
      event.stopImmediatePropagation();
      return;
    }
    if ((input === "o" && key.ctrl) || input === "\u000f") {
      setTranscriptMode((current) => !current);
      event.stopImmediatePropagation();
      return;
    }
    if (transcriptMode && key.escape) {
      setTranscriptMode(false);
      event.stopImmediatePropagation();
      return;
    }
    if (transcriptMode && input === "c" && key.ctrl) {
      setTranscriptMode(false);
      event.stopImmediatePropagation();
      return;
    }
    if (key.escape) {
      if (cancelCurrentInteraction() || interruptActiveWork()) {
        event.stopImmediatePropagation();
        return;
      }
    }
    if (input === "c" && key.ctrl) {
      handleCtrlC();
      event.stopImmediatePropagation();
      return;
    }
    const mainScroll = mainScrollRef.current;
    if (planApprovalOverlayVisible && (key.wheelUp || key.pageUp)) {
      scrollPlanApprovalDocument(key.wheelUp ? -3 : -Math.max(1, planApprovalDocumentMaxLines - 1));
      event.stopImmediatePropagation();
      return;
    }
    if (planApprovalOverlayVisible && (key.wheelDown || key.pageDown)) {
      scrollPlanApprovalDocument(key.wheelDown ? 3 : Math.max(1, planApprovalDocumentMaxLines - 1));
      event.stopImmediatePropagation();
      return;
    }
    if (mainScroll && key.wheelUp) {
      scrollMainUp(mainScroll, 3);
      return;
    }
    if (mainScroll && key.wheelDown) {
      scrollMainDown(mainScroll, 3);
      return;
    }
    if (activeChoice && (key.upArrow || key.downArrow || key.return || (!planApprovalOverlayVisible && (key.pageUp || key.pageDown)))) return;
    if (mainScroll && key.pageUp) {
      jumpMainScrollBy(mainScroll, -Math.max(1, Math.floor(mainScroll.getViewportHeight() / 2)));
      return;
    }
    if (mainScroll && key.pageDown) {
      jumpMainScrollBy(mainScroll, Math.max(1, Math.floor(mainScroll.getViewportHeight() / 2)));
      return;
    }
  });
  if (initialError) {
    return (
      <Box flexDirection="column" height={terminalRows}>
        <Header cwd={cwd} />
        <Text color="red">{initialError}</Text>
        <Text>Create config/prompt.md, config/roles, and config/workflows</Text>
      </Box>
    );
  }
  const promptMode: PromptInputMode =
    interactionMode === "waiting_plan_approval"
      ? "waiting_plan_review"
      : interactionMode === "running"
        ? "running"
        : interactionMode === "permission"
          ? "permission"
          : interactionMode === "question"
            ? "question"
            : interactionMode === "confirm_interrupt"
              ? "confirm_interrupt"
              : "input";
  const isLoading = state.mode === "running" || state.mode === "permission" || planWorkCount > 0;
  return (
    <Box flexDirection="column" height={terminalRows}>
      <Header cwd={cwd} workflowId={state.workflowId} sessionId={currentSessionIdRef.current} />
      <WorkflowFlowChart workflowNodes={workflowNodes} nodes={state.nodes} currentNodeId={state.currentNodeId} suspendedStack={state.suspendedStack} />
      {halfScreenChoice ? null : (
        <Box flexDirection="row" height={layout.mainHeight}>
          <ScrollBox ref={mainScrollRef} flexDirection="column" flexGrow={1} height={layout.mainHeight} stickyScroll={!planApprovalOverlayVisible}>
          {planApprovalOverlayVisible && state.pendingReview ? (
            <PlanApprovalOverlay review={state.pendingReview} planFilePath={planApprovalPlanFilePath} editorName={externalEditorDisplayName()} maxDocumentLines={planApprovalDocumentMaxLines} scrollOffset={planApprovalDocumentOffset} />
          ) : (
            <>
              <RunLogPanel
                items={logMessages}
                detailMode={transcriptMode}
              />
              <ResultPanel mode={state.mode} error={state.error} runId={state.runId} />
            </>
          )}
          </ScrollBox>
          <MainScrollBar
          scrollRef={mainScrollRef}
          height={layout.mainHeight}
          contentRevision={logMessages}
          layoutRevision={transcriptMode + ":" + state.mode}
          enabled={!planApprovalOverlayVisible}
          />
        </Box>
      )}
      <InteractionArea
        choice={activeChoice}
        mode={promptMode}
        workflowId={state.workflowId}
        queued={queued.map((item) => item.text)}
        workflows={workflows}
        skills={[...(skillRuntime?.listSkills().map((skill) => ({ name: skill.name, description: skill.description, argumentHint: skill.argumentHint })) ?? []), ...(mcpRuntime?.listPromptCommands().map((command) => ({ name: command.name, description: command.description, argumentHint: command.argumentHint })) ?? [])]}
        questions={state.questions}
        isLoading={isLoading}
        permissionMode={state.inputPermissionMode}
        historyStore={promptHistoryStore}
        hasSelection={hasSelection}
        promptText={promptText}
        inputDisabled={transcriptMode}
        activityStatus={activityStatus}
        resolvePromptImagePaste={state.pendingReview || state.mode === "planning" || (state.mode === "input" && state.inputPermissionMode === "plan") ? resolvePlanPromptImagePaste : undefined}
        onPromptEvent={handlePromptEvent}
        onPromptTextChange={handlePromptTextChange}
      />
      <StatusLine
        mode={interactionMode}
        permissionMode={state.inputPermissionMode}
        workflowId={state.workflowId}
        runId={state.runId}
        isLoading={isLoading}
        hasSelection={hasSelection}
        sessionUsage={state.sessionUsage}
        modelRequestCount={state.modelRequestCount}
        elements={statuslineElements}
        columns={terminalColumns}
      />
    </Box>
  );
}
function activityStatusText(input: { isWorking: boolean; workStartedAtMs?: number; lastWorkDurationMs?: number; nowMs: number; detail?: string }): string | undefined {
  if (input.isWorking && input.workStartedAtMs !== undefined) {
    const detail = input.detail ? ` (${input.detail})` : "";
    return `Working... ${formatWorkDuration(input.nowMs - input.workStartedAtMs)}${detail}`;
  }
  if (!input.isWorking && input.lastWorkDurationMs !== undefined) return `Worked for ${formatWorkDuration(input.lastWorkDurationMs)}`;
  return undefined;
}
function formatWorkDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}
function statusLog(text: string, detailText?: string): TuiLogMessage {
  return { id: randomUUID(), kind: "status", text, detailText };
}
function appendUserLogMessage(state: TuiState, text: string): TuiState {
  if (!text) return state;
  return {
    ...state,
    conversation: [...state.conversation, { kind: "user", text }],
    logMessages: [...state.logMessages, { id: randomUUID(), kind: "user", text }]
  };
}
function appendMissingUserLogMessage(state: TuiState, text: string | undefined): TuiState {
  const normalized = text?.trim();
  if (!normalized) return state;
  if (state.logMessages.some((message) => message.kind === "user" && message.text === normalized)) return state;
  return appendUserLogMessage(state, normalized);
}
function waitForUiTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
function isPlanApprovalToggleInput(input: string): boolean {
  return input === "`" || input === "·" || input === "｀";
}

function runtimeWorkStatusDetail(event: RuntimeEvent): string | undefined {
  if (event.type === "runtime_tool_invoked") return `Plan Mode is thinking · Running ${getToolDisplayName(event.tool)}`;
  if (event.type === "runtime_tool_completed" || event.type === "runtime_tool_failed") return "Plan Mode is thinking";
  if (event.type === "runtime_assistant_message") return "Plan Mode is thinking";
  return undefined;
}
function reducePlanRuntimeEvent(state: TuiState, event: RuntimeEvent): TuiState {
  switch (event.type) {
    case "runtime_assistant_message":
      return appendPlanAssistantLog(state, event.content);
    case "runtime_tool_invoked":
      if (event.tool === "AskUserQuestion") return state;
      return appendPlanToolLog(state, event.tool_call_id, event.tool, event.input);
    case "runtime_tool_completed":
      if (event.tool === "AskUserQuestion") return state;
      return updatePlanToolLog(state, event.tool_call_id, event.tool, "completed", getToolResultDetail(event.result), getCompactToolResultDetail(event.result));
    case "runtime_tool_failed":
      if (event.tool === "AskUserQuestion") return state;
      return updatePlanToolLog(state, event.tool_call_id, event.tool, "failed", `错误：${event.error}`);
    default:
      return state;
  }
}
function appendPlanAssistantLog(state: TuiState, content: string): TuiState {
  const text = content.trim();
  if (!text) return state;
  let lastUserIndex = -1;
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    if (state.logMessages[index]?.kind === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const lastAssistant = [...state.logMessages.slice(lastUserIndex + 1)].reverse().find((message) => message.kind === "assistant" && message.nodeId === planRuntimeNodeId && message.attempt === planRuntimeAttempt);
  if (lastAssistant?.text === text) return state;
  return {
    ...state,
    conversation: [...state.conversation, { kind: "assistant", nodeId: planRuntimeNodeId, attempt: planRuntimeAttempt, text }],
    logMessages: [...state.logMessages, { id: randomUUID(), kind: "assistant", nodeId: planRuntimeNodeId, attempt: planRuntimeAttempt, text }]
  };
}
function appendPlanAssistantLogsFromMessages(state: TuiState, messages: ModelMessage[]): TuiState {
  return messages.reduce((next, message) => {
    if (message.role !== "assistant" || message.tool_calls?.length || typeof message.content !== "string") return next;
    const text = message.content.trim();
    if (!text) return next;
    return appendPlanAssistantLog(next, text);
  }, state);
}
function planRuntimeNewMessages(inputMessages: ModelMessage[], resultMessages: ModelMessage[]): ModelMessage[] {
  const inputCount = inputMessages.filter((message) => !isRuntimeAttachmentMessage(message)).length;
  return resultMessages.filter((message) => !isRuntimeAttachmentMessage(message)).slice(inputCount);
}
function isRuntimeAttachmentMessage(message: ModelMessage): boolean {
  return Boolean(message.metadata?.runtimeAttachment);
}
function appendPlanToolLog(state: TuiState, toolCallId: string, tool: string, input: unknown): TuiState {
  const parentLogId = findPlanToolParentAssistantLog(state);
  return {
    ...state,
    tools: [
      ...state.tools,
      {
        nodeId: planRuntimeNodeId,
        attempt: planRuntimeAttempt,
        toolCallId,
        tool,
        status: "running",
        input,
        expanded: false
      }
    ],
    logMessages: [
      ...state.logMessages,
      {
        id: randomUUID(),
        kind: "tool",
        nodeId: planRuntimeNodeId,
        attempt: planRuntimeAttempt,
        toolCallId,
        parentLogId,
        tool,
        status: "running",
        text: getToolDisplayName(tool),
        summary: getToolInputSummary(tool, input),
        detailText: getToolInputDetail(tool, input)
      }
    ]
  };
}
function updatePlanToolLog(state: TuiState, toolCallId: string, tool: string, status: "completed" | "failed", detailText: string, compactDetailText?: string): TuiState {
  const hasLog = state.logMessages.some((message) => message.kind === "tool" && message.toolCallId === toolCallId);
  const tools = state.tools.some((item) => item.toolCallId === toolCallId)
    ? state.tools.map((item) => item.toolCallId === toolCallId ? { ...item, status } : item)
    : [
        ...state.tools,
        {
          nodeId: planRuntimeNodeId,
          attempt: planRuntimeAttempt,
          toolCallId,
          tool,
          status,
          expanded: false
        }
      ];
  if (!hasLog) {
    return {
      ...state,
      tools,
      logMessages: [
        ...state.logMessages,
        {
          id: randomUUID(),
          kind: "tool",
          nodeId: planRuntimeNodeId,
          attempt: planRuntimeAttempt,
          toolCallId,
          tool,
          status,
          text: getToolDisplayName(tool),
          summary: "",
          detailText,
          compactDetailText
        }
      ]
    };
  }
  return {
    ...state,
    tools,
    logMessages: state.logMessages.map((message) => (
      message.kind === "tool" && message.toolCallId === toolCallId
        ? { ...message, status, detailText, compactDetailText }
        : message
    ))
  };
}
function findPlanToolParentAssistantLog(state: TuiState): string | undefined {
  for (let index = state.logMessages.length - 1; index >= 0; index -= 1) {
    const item = state.logMessages[index];
    if (item.kind === "assistant" && item.nodeId === planRuntimeNodeId && item.attempt === planRuntimeAttempt) return item.id;
    if (item.parentLogId) continue;
    if (item.kind === "tool" && item.nodeId === planRuntimeNodeId && item.attempt === planRuntimeAttempt) continue;
    return undefined;
  }
  return undefined;
}
const planRuntimeNodeId = "global-plan";
const planRuntimeAttempt = 1;
function planApprovalKernelSession(input: {
  cwd: string;
  plan: PlanSessionState;
  document: string;
  messages?: ModelMessage[];
  review?: TuiState["pendingReview"];
  defaultExecutionMode: DefaultExecutionMode;
}): KernelSession {
  const interaction: PendingInteraction = {
    type: "plan_approval",
    id: `${input.plan.sessionId}:tui-plan-approval`,
    sessionId: input.plan.sessionId,
    planFilePath: input.plan.planFilePath,
    empty: !input.document.trim(),
    requestedPermissions: input.review?.requestedPermissions,
    toolCallId: input.review?.toolCallId ?? input.plan.approvalToolCallId
  };
  return {
    id: input.plan.sessionId,
    cwd: input.cwd,
    status: "waiting_plan_approval",
    messages: input.messages ?? [],
    toolPermissionContext: {
      mode: "plan",
      prePlanMode: input.plan.prePlanMode,
      allow: [],
      ask: [],
      deny: [],
      planFilePath: input.plan.planFilePath
    },
    defaultExecutionMode: input.defaultExecutionMode,
    planState: input.plan,
    workflowBinding: null,
    pendingInteraction: interaction
  };
}

function globalPlanLog(document: string, path?: string, requestedPermissions?: PlanRequestedPermission[], empty?: boolean): TuiLogMessage {
  const displayDocument = document || "Einstein wants to exit plan mode";
  return {
    id: randomUUID(),
    kind: "plan",
    nodeId: "global-plan",
    attempt: 1,
    status: "pending",
    text: empty ? "Exit Plan Mode" : "Plan Review",
    document: displayDocument,
    detailText: displayDocument,
    detailVisible: true,
    path,
    requestedPermissions
  };
}
function planLogMessagesFromTranscript(messages: ModelMessage[]): TuiLogMessage[] {
  const logs: TuiLogMessage[] = [];
  for (const message of messages) {
    if (typeof message.content !== "string" || !message.content.trim()) continue;
    if (message.role === "user") {
      if (message.content.startsWith(planRejectionPrefix)) continue;
      logs.push({ id: randomUUID(), kind: "user", text: message.content });
      continue;
    }
    if (message.role === "assistant") {
      logs.push({ id: randomUUID(), kind: "assistant", text: message.content });
    }
  }
  return logs;
}
function resumeEntryLabel(entry: TuiState["resumeRuns"][number]): string {
  const updatedAt = new Date(entry.updatedAt);
  const timestamp = `${String(updatedAt.getMonth() + 1).padStart(2, "0")}-${String(updatedAt.getDate()).padStart(2, "0")} ${String(updatedAt.getHours()).padStart(2, "0")}:${String(updatedAt.getMinutes()).padStart(2, "0")}`;
  if (entry.kind === "session") {
    const status = entry.planMode ?? entry.status ?? "session";
    return `${timestamp} session ${status} ${entry.inputPreview || entry.sessionId}`;
  }
  return `${timestamp} ${entry.workflowId} ${entry.status} ${entry.inputPreview || entry.runId}`;
}

function inputPreview(input: unknown): string {
  let text = "";
  if (typeof input === "string") text = input;
  else if (input && typeof input === "object") {
    const value = input as Record<string, unknown>;
    if (typeof value.request === "string") text = value.request;
    else if (typeof value.answer === "string") text = value.answer;
    else text = JSON.stringify(value);
  } else if (input !== undefined) text = String(input);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
function isEmptyPlanOriginalInput(input: unknown): boolean {
  if (!input || typeof input !== "object") return input === undefined || input === "";
  const request = (input as { request?: unknown }).request;
  return typeof request === "string" && request.trim() === "";
}
export function planRejectionMessage(document: string, feedback: unknown): ModelMessage {
  const images = feedbackImages(feedback);
  const text = [
    planRejectionPrefix,
    document.trim() || "(empty plan)",
    "",
    "User feedback:",
    feedbackText(feedback) ?? (images.length ? "(see attached image)" : "(no feedback provided)")
  ].join("\n");
  if (!images.length) return { role: "user", content: text };
  return { role: "user", content: [{ type: "text", text }, ...images] };
}

const planRejectionPrefix = "The agent proposed a plan that was rejected by the user. The user chose to stay in plan mode rather than proceed with implementation.\n\nRejected plan:";

function feedbackText(feedback: unknown): string | undefined {
  if (!feedback || typeof feedback !== "object") return typeof feedback === "string" && feedback.trim() ? feedback.trim() : undefined;
  const answer = (feedback as { answer?: unknown }).answer;
  return typeof answer === "string" && answer.trim() ? answer.trim() : undefined;
}

function feedbackImages(feedback: unknown): ModelContentPart[] {
  if (!feedback || typeof feedback !== "object") return [];
  const images = (feedback as { images?: unknown; contentBlocks?: unknown }).images ?? (feedback as { contentBlocks?: unknown }).contentBlocks;
  if (!Array.isArray(images)) return [];
  return images.flatMap((image) => {
    const normalized = normalizeFeedbackImage(image);
    return normalized ? [normalized] : [];
  });
}

function imageFeedbackFromText(value: string): { answer: string; contentBlocks: ModelContentPart[] } {
  const contentBlocks: ModelContentPart[] = [];
  const answer = value.replace(/data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)/g, (_match, mediaType: "image/png" | "image/jpeg" | "image/webp", data: string) => {
    if (data.trim()) contentBlocks.push({ type: "image", media_type: mediaType, data });
    return "";
  }).trim();
  return { answer, contentBlocks };
}

function uniqueImageBlocks(images: ModelContentPart[]): ModelContentPart[] {
  const seen = new Set<string>();
  const unique: ModelContentPart[] = [];
  for (const image of images) {
    if (image.type !== "image") continue;
    const key = `${image.media_type}:${image.data}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(image);
  }
  return unique;
}

function normalizeFeedbackImage(image: unknown): ModelContentPart | undefined {
  if (!image || typeof image !== "object" || (image as { type?: unknown }).type !== "image") return undefined;
  const direct = image as { media_type?: unknown; mediaType?: unknown; data?: unknown; content?: unknown };
  const source = (image as { source?: unknown }).source;
  const sourceValue = source && typeof source === "object" ? source as { media_type?: unknown; data?: unknown } : undefined;
  const mediaType = direct.media_type ?? direct.mediaType ?? sourceValue?.media_type;
  const data = direct.data ?? direct.content ?? sourceValue?.data;
  if (!isImageMediaType(mediaType) || typeof data !== "string" || !data.trim()) return undefined;
  return { type: "image", media_type: mediaType, data };
}

function isImageMediaType(value: unknown): value is "image/png" | "image/jpeg" | "image/webp" {
  return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function answerText(answer: unknown): string {
  if (typeof answer === "string") return answer;
  if (answer && typeof answer === "object") {
    const value = (answer as { answer?: unknown }).answer;
    if (typeof value === "string") return value;
  }
  return JSON.stringify(answer);
}

function freeformQuestionAnswer(questions: unknown[], text: string): unknown {
  const question = questions.find((item) => questionAllowsFreeform(item)) ?? questions[0];
  return {
    answer: text,
    question_id: questionId(question),
    option_value: otherQuestionOptionValue
  };
}

function nextQuestionSlice(questions: unknown[], index: number, answers: Record<string, unknown> = {}): unknown[] {
  const question = questions[index];
  if (question === undefined) return [];
  if (!question || typeof question !== "object") return [question];
  return [{ ...question as Record<string, unknown>, __questionIndex: index, __questionCount: questions.length, __allQuestions: questions, __answers: answers }];
}

function multiQuestionToolAnswer(rawAnswers: Record<string, unknown>): { answers: Record<string, unknown>; annotations?: Record<string, unknown> } {
  const answers: Record<string, unknown> = {};
  const annotations: Record<string, unknown> = {};
  for (const [question, answer] of Object.entries(rawAnswers)) {
    answers[question] = answerValue(answer);
    const annotation = answerAnnotation(answer);
    if (annotation) annotations[question] = annotation;
  }
  return Object.keys(annotations).length ? { answers, annotations } : { answers };
}

function submitQuestionReview(questions: unknown[], answers: Record<string, unknown>): unknown {
  return {
    __submitQuestionReview: true,
    questions,
    answers,
    detail: submitQuestionReviewDetail(questions, answers),
    __questionIndex: questions.length,
    __questionCount: questions.length
  };
}

function submitQuestionReviewDetail(questions: unknown[], answers: Record<string, unknown>): string {
  const lines: string[] = [];
  if (questions.some((question) => !Object.prototype.hasOwnProperty.call(answers, questionText(question)))) {
    lines.push("⚠ You have not answered all questions");
  }
  for (const question of questions) {
    const text = questionText(question);
    if (!Object.prototype.hasOwnProperty.call(answers, text)) continue;
    lines.push(`• ${text}`, `  → ${String(answerValue(answers[text]) ?? "")}`);
  }
  lines.push("", "Ready to submit your answers?");
  return lines.join("\n");
}

function submitQuestionReviewData(value: unknown): { detail: string; questions: unknown[]; answers: Record<string, unknown> } | undefined {
  if (!value || typeof value !== "object" || (value as { __submitQuestionReview?: unknown }).__submitQuestionReview !== true) return undefined;
  const detail = (value as { detail?: unknown }).detail;
  const questions = (value as { questions?: unknown }).questions;
  const answers = (value as { answers?: unknown }).answers;
  return {
    detail: typeof detail === "string" ? detail : "",
    questions: Array.isArray(questions) ? questions : [],
    answers: answers && typeof answers === "object" ? answers as Record<string, unknown> : {}
  };
}

function isSubmitQuestionAnswer(answer: unknown): boolean {
  return Boolean(answer && typeof answer === "object" && (answer as { type?: unknown }).type === "__submit_answers__");
}

function isRespondToClaudeQuestionAnswer(answer: unknown): boolean {
  return Boolean(answer && typeof answer === "object" && (answer as { type?: unknown }).type === "__respond_to_claude__");
}

function isFinishPlanInterviewQuestionAnswer(answer: unknown): boolean {
  return Boolean(answer && typeof answer === "object" && (answer as { type?: unknown }).type === "__finish_plan_interview__");
}

function isCancelQuestionAnswer(answer: unknown): boolean {
  return Boolean(answer && typeof answer === "object" && (answer as { type?: unknown }).type === "__cancel_question__");
}

const planQuestionRejectMessage = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

function planQuestionCancelPayload(): { error: string; rejected: true } {
  return { error: planQuestionRejectMessage, rejected: true };
}

function planQuestionInterviewFeedback(questions: unknown[], rawAnswers: Record<string, unknown>, finish: boolean): { feedback: string; answers: Record<string, unknown>; action: string } {
  const answers = multiQuestionToolAnswer(rawAnswers).answers;
  const questionsWithAnswers = questions.map((question) => {
    const text = questionText(question);
    const answer = answers[text];
    return answer ? `- "${text}"\n  Answer: ${String(answer)}` : `- "${text}"\n  (No answer provided)`;
  }).join("\n");
  const feedback = finish
    ? `The user has indicated they have provided enough answers for the plan interview.\nStop asking clarifying questions and proceed to finish the plan with the information you have.\n\nQuestions asked and answers provided:\n${questionsWithAnswers}`
    : `The user wants to clarify these questions.\nThis means they may have additional information, context or questions for you.\nTake their response into account and then reformulate the questions if appropriate.\nStart by asking them what they would like to clarify.\n\nQuestions asked:\n${questionsWithAnswers}`;
  return { action: finish ? "__finish_plan_interview__" : "__respond_to_claude__", feedback, answers };
}

function questionNavigationDirection(answer: unknown): "previous" | "next" | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const type = (answer as { type?: unknown }).type;
  if (type === previousQuestionOptionValue || type === previousQuestionNavigationValue) return "previous";
  if (type === nextQuestionNavigationValue) return "next";
  return undefined;
}

function answerValue(answer: unknown): unknown {
  if (!answer || typeof answer !== "object") return answer;
  const value = (answer as { answer?: unknown }).answer;
  if (Array.isArray(value)) return value.join(", ");
  return value ?? answer;
}

function answerAnnotation(answer: unknown): unknown | undefined {
  if (!answer || typeof answer !== "object") return undefined;
  const value = answer as { annotations?: unknown; preview?: unknown };
  if (value.annotations) return value.annotations;
  if (typeof value.preview === "string" && value.preview.trim()) return { preview: value.preview };
  return undefined;
}

function questionProgress(question: unknown): { index: number; count: number } | undefined {
  if (!question || typeof question !== "object") return undefined;
  const value = question as { __questionIndex?: unknown; __questionCount?: unknown };
  return typeof value.__questionIndex === "number" && typeof value.__questionCount === "number" && value.__questionCount > 1
    ? { index: value.__questionIndex, count: value.__questionCount }
    : undefined;
}

function questionsFromQuestion(question: unknown): unknown[] {
  if (!question || typeof question !== "object") return [];
  const questions = (question as { __allQuestions?: unknown }).__allQuestions;
  return Array.isArray(questions) ? questions : [question];
}

function questionAnswerContext(question: unknown): { __allQuestions?: unknown[] } {
  const questions = questionsFromQuestion(question);
  return questions.length > 1 ? { __allQuestions: questions } : {};
}

function questionsFromAnswer(answer: unknown): unknown[] {
  if (!answer || typeof answer !== "object") return [];
  const questions = (answer as { __allQuestions?: unknown }).__allQuestions;
  return Array.isArray(questions) ? questions : [];
}

function answersFromQuestion(question: unknown): Record<string, unknown> {
  if (!question || typeof question !== "object") return {};
  const answers = (question as { __answers?: unknown }).__answers;
  return answers && typeof answers === "object" ? answers as Record<string, unknown> : {};
}

function questionNavigationData(
  questions: unknown[],
  currentIndex: number,
  answers: Record<string, unknown>
): InteractionChoice["questionNavigation"] | undefined {
  if (questions.length <= 1) return undefined;
  return {
    questions: questions.map((question, index) => ({
      text: questionText(question),
      header: questionHeader(question, index)
    })),
    currentIndex,
    answers
  };
}

function questionLogDetail(questions: unknown[]): string {
  return questions.map((question) => questionText(question)).join("\n");
}
function nextInputPermissionMode(mode: PermissionMode, defaultExecutionMode: Exclude<PermissionMode, "plan">): PermissionMode {
  return mode === "plan" ? defaultExecutionMode : "plan";
}

function workflowPermissionMode(mode: PermissionMode): Exclude<PermissionMode, "plan"> | undefined {
  return mode === "plan" ? undefined : mode;
}

function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "fullAccess") return "Full access";
  if (mode === "plan") return "Plan Mode";
  return "Default";
}
export type ActiveChoiceCancelAction =
  | { type: "none" }
  | { type: "exit"; key: string }
  | { type: "restore_mode"; mode: TuiState["mode"]; key: string; clearPendingResumeRunId?: boolean; clearResumePicker?: boolean }
  | { type: "deny_permission"; requestId: string; key: string }
  | { type: "cancel_plan_approval"; key: string };
export function resolveActiveChoiceCancel(state: {
  mode: TuiState["mode"];
  workflowId?: string;
  modeBeforeConfirmation?: TuiState["mode"];
  pendingResumeRunId?: string;
  permissionRequests?: Array<{ requestId: string }>;
  pendingReview?: { nodeId: string; attempt: number };
}): ActiveChoiceCancelAction {
  if (state.mode === "permission") {
    const request = state.permissionRequests?.[0];
    return request ? { type: "deny_permission", requestId: request.requestId, key: `permission:${request.requestId}` } : { type: "none" };
  }
  if (state.mode === "waiting_plan_approval") {
    const review = state.pendingReview;
    return review ? { type: "cancel_plan_approval", key: `plan:${review.nodeId}:${review.attempt}` } : { type: "none" };
  }
  if (state.mode === "confirm_interrupt") return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "running", key: "confirm_interrupt" };
  if (state.mode === "confirm_new") return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "running", key: "confirm_new" };
  if (state.mode === "confirm_resume") {
    const key = state.pendingResumeRunId ? `confirm_resume:${state.pendingResumeRunId}` : "confirm_resume";
    return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "running", clearPendingResumeRunId: true, key };
  }
  if (state.mode === "resume_picker") return { type: "restore_mode", mode: "input", clearResumePicker: true, key: "resume_picker" };
  if (state.mode === "permissions") return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "input", key: "permissions" };
  if (state.mode === "select_workflow") return state.workflowId ? { type: "restore_mode", mode: "input", key: "select_workflow" } : { type: "exit", key: "select_workflow" };
  return { type: "none" };
}
export function resolveCtrlCBehavior(mode: TuiState["mode"], hasSession: boolean, hasSelection = false): "copy_selection" | "exit" | "confirm_interrupt" | "interrupt" {
  if (hasSelection) return "copy_selection";
  if (!hasSession || !isActiveSessionMode(mode)) return "exit";
  return mode === "confirm_interrupt" ? "interrupt" : "confirm_interrupt";
}
function isActiveSessionMode(mode: TuiState["mode"]): boolean {
  return mode === "running" || mode === "permission" || mode === "question" || mode === "planning" || mode === "waiting_plan_approval" || mode === "confirm_interrupt" || mode === "confirm_new" || mode === "confirm_resume";
}
function isConfirmationMode(mode: TuiState["mode"]): boolean {
  return mode === "confirm_interrupt" || mode === "confirm_new" || mode === "confirm_resume";
}
function workflowResultMode(status: WorkflowSession["state"]["status"]): TuiState["mode"] {
  if (status === "waiting_user") return "question";
  return "paused";
}
function buildActiveChoice(input: {
  mode: TuiState["mode"];
  workflows: string[];
  workflowConfigs?: AgentTeamConfig["workflows"];
  previewWorkflowId?: string;
  previewWorkflow: (workflow: string) => void;
  permission?: TuiState["permissionRequests"][number];
  review?: TuiState["pendingReview"];
  questions: TuiState["questions"];
  isPlanQuestion?: boolean;
  planFilePath?: string;
  planApprovalPlanFilePath?: string;
  planApprovalEditorName?: string;
  planApprovalChoiceOnly?: boolean;
  showClearContextOnPlanAccept?: boolean;
  contextUsedPercent?: number;
  isFullAccessModeAvailable?: boolean;
  defaultExecutionMode: TuiDefaultExecutionMode;
  resumeRuns: TuiState["resumeRuns"];
  selectWorkflow: (workflow: string) => void;
  resolvePermission: (requestId: string, decision: "allow_once" | "deny_once") => void;
  resolvePlan: (decision: "continue" | "stay", mode?: PermissionMode, feedback?: unknown, options?: { clearContext?: boolean }) => void;
  cancelPlanApproval: () => void;
  planApprovalPromptFeedback: (text: string, images?: PromptInputImageAttachment[]) => unknown;
  planApprovalAcceptFeedback: () => unknown;
  updatePlanApprovalFeedback: (text: string) => void;
  hasPlanApprovalFeedback: () => boolean;
  planApprovalImages?: SelectImageAttachment[];
  addPlanApprovalImage?: (image: Omit<SelectImageAttachment, "id">) => void;
  removePlanApprovalImage?: (id: number) => void;
  resolvePlanApprovalImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
  planQuestionImages?: Record<string, SelectImageAttachment[]>;
  addPlanQuestionImage?: (question: string, image: Omit<SelectImageAttachment, "id">) => void;
  removePlanQuestionImage?: (question: string, id: number) => void;
  resolvePlanQuestionImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
  resolveQuestion: (answer: unknown) => void;
  editQuestionText: ExternalTextEditor;
  resolveInterrupt: (decision: "interrupt" | "stay") => void;
  resolveResume: (runId: string) => void;
  resolveNew: (decision: "new" | "stay") => void;
  resolvePendingResume: (decision: "resume" | "stay") => void;
  resolveDefaultExecutionMode: (mode: TuiDefaultExecutionMode) => void;
}): InteractionChoice | undefined {
  if (input.mode === "select_workflow" && input.workflows.length) {
    const options: InteractionChoice["options"] = input.workflows.map((workflow) => ({
      label: workflow,
      value: workflow,
      description: input.workflowConfigs?.[workflow]?.description || undefined
    }));
    let createWorkflowValue = "__create_new_workflow__";
    while (input.workflows.includes(createWorkflowValue)) createWorkflowValue = `_${createWorkflowValue}`;
    options.push({
      label: "Create new workflow",
      value: createWorkflowValue,
      description: "Coming soon",
      disabled: true
    });
    const selectedValue = input.previewWorkflowId && input.workflows.includes(input.previewWorkflowId)
      ? input.previewWorkflowId
      : input.workflows[0];
    return {
      title: "Select workflow",
      placement: "half-screen",
      options,
      selectedValue,
      onFocus: input.previewWorkflow,
      onSubmit: input.selectWorkflow
    };
  }
  if (input.mode === "resume_picker" && input.resumeRuns.length) {
    const options = input.resumeRuns.map((run) => ({
      label: resumeEntryLabel(run),
      value: run.id
    }));
    const selectedValue = options[0]?.value ?? "";
    return { title: "Resume workflow run", placement: "half-screen", options, selectedValue, onSubmit: input.resolveResume };
  }
  if (input.mode === "confirm_new") {
    const options = [
      { label: "Start new workflow", value: "new" },
      { label: "Keep current workflow", value: "stay" }
    ];
    const selectedValue = options[0].value;
    return { title: "Start a new workflow?", options, selectedValue, onSubmit: (value) => input.resolveNew(value === "new" ? "new" : "stay") };
  }
  if (input.mode === "confirm_resume") {
    const options = [
      { label: "Resume selected workflow", value: "resume" },
      { label: "Keep current workflow", value: "stay" }
    ];
    const selectedValue = options[0].value;
    return { title: "Resume another workflow?", options, selectedValue, onSubmit: (value) => input.resolvePendingResume(value === "resume" ? "resume" : "stay") };
  }
  if (input.mode === "permissions") {
    const options = [
      { label: "Default", value: "default" },
      { label: "Full access", value: "fullAccess" }
    ];
    return {
      title: "Default execution mode",
      detail: "Choose the execution mode used outside Plan Mode.",
      options,
      selectedValue: input.defaultExecutionMode,
      onCancel: () => input.resolveDefaultExecutionMode(input.defaultExecutionMode),
      onSubmit: (value) => input.resolveDefaultExecutionMode(value === "fullAccess" ? "fullAccess" : "default")
    };
  }
  if (input.mode === "permission" && input.permission) {
    if (input.permission.tool === "EnterPlanMode") {
      const options = [
        { label: "Yes, enter plan mode", value: "allow_once" },
        { label: "No, start implementing now", value: "deny_once" }
      ];
      return {
        title: "Enter plan mode?",
        detail: [
          "Einstein wants to enter plan mode to explore and design an implementation approach.",
          "",
          "In plan mode, Einstein will:",
          " · Explore the codebase thoroughly",
          " · Identify existing patterns",
          " · Design an implementation strategy",
          " · Present a plan for your approval",
          "",
          "No code changes will be made until you approve the plan."
        ].join("\n"),
        options,
        selectedValue: options[0].value,
        onCancel: () => input.resolvePermission(input.permission?.requestId ?? "", "deny_once"),
        onSubmit: (value) => input.resolvePermission(input.permission?.requestId ?? "", value === "deny_once" ? "deny_once" : "allow_once")
      };
    }
    const options = [
      { label: "Allow once", value: "allow_once" },
      { label: "Deny once", value: "deny_once" }
    ];
    const selectedValue = options[0].value;
    return {
      title: "Permission required",
      detail: `${input.permission.tool} ${input.permission.specifier}`,
      options,
      selectedValue,
      onSubmit: (value) => input.resolvePermission(input.permission?.requestId ?? "", value === "deny_once" ? "deny_once" : "allow_once")
    };
  }
  if (input.mode === "question") {
    const questionChoice = buildQuestionChoice({
      questions: input.questions,
      isPlanQuestion: input.isPlanQuestion === true,
      planFilePath: input.planFilePath,
      resolveQuestion: input.resolveQuestion,
      editQuestionText: input.editQuestionText,
      imagesByQuestion: input.planQuestionImages,
      addImage: input.addPlanQuestionImage,
      removeImage: input.removePlanQuestionImage,
      resolveImagePaste: input.resolvePlanQuestionImagePaste
    });
    if (questionChoice) return questionChoice;
  }
  if (input.mode === "waiting_plan_approval" && input.review) {
    if (input.review.empty || !input.review.document.trim()) {
      const options: InteractionChoice["options"] = [
        { label: "Yes", value: "yes-default-keep-context" },
        {
          type: "input",
          label: "No, keep planning",
          value: "stay",
          placeholder: "Tell Einstein what to change",
          allowEmptySubmitToCancel: true,
          showLabelWithValue: true,
          labelValueSeparator: ": ",
          onChange: input.updatePlanApprovalFeedback
        }
      ];
      return {
        title: "Exit plan mode?",
        hideTitle: input.planApprovalChoiceOnly === true,
        detail: input.planApprovalChoiceOnly === true ? undefined : "Einstein wants to exit plan mode",
        documentBlock: input.planApprovalChoiceOnly === true ? undefined : {
          title: "Plan file:",
          text: planApprovalDocument(input.review.document || "No plan found. Please write your plan to the plan file first.", input.planApprovalPlanFilePath),
          maxLines: 6,
          scrollable: true
        },
        options,
        selectedValue: options[0].value,
        hidePromptInput: true,
        imageAttachments: input.planApprovalImages,
        onImagePaste: input.addPlanApprovalImage,
        onRemoveImage: input.removePlanApprovalImage,
        resolveImagePaste: input.resolvePlanApprovalImagePaste,
        onCancel: input.cancelPlanApproval,
        onSubmit: (value) => input.resolvePlan(value === "stay" ? "stay" : "continue", input.defaultExecutionMode),
        onPromptSubmit: (text, _focusedValue, images) => {
          input.resolvePlan("stay", "default", input.planApprovalPromptFeedback(text, images));
        }
      };
    }
    const options = buildPlanApprovalOptions(
      input.showClearContextOnPlanAccept === true,
      input.contextUsedPercent ?? null,
      input.isFullAccessModeAvailable === true,
      input.updatePlanApprovalFeedback
    );
    return {
      title: "Ready to code?",
      hideTitle: input.planApprovalChoiceOnly === true,
      detail: input.planApprovalChoiceOnly === true ? undefined : planApprovalDetail({
        requestedPermissions: input.review.requestedPermissions,
        savedMessage: input.review.savedMessage,
        planFilePath: input.planApprovalPlanFilePath,
        editorName: input.planApprovalEditorName
      }),
      documentBlock: input.planApprovalChoiceOnly === true ? undefined : {
        title: "Here is Einstein's plan:",
        text: planApprovalDocument(input.review.document, input.planApprovalPlanFilePath),
        maxLines: 20,
        scrollable: true
      },
      options,
      selectedValue: options[0]?.value ?? "yes-default-keep-context",
      hidePromptInput: true,
      imageAttachments: input.planApprovalImages,
      onImagePaste: input.addPlanApprovalImage,
      onRemoveImage: input.removePlanApprovalImage,
      resolveImagePaste: input.resolvePlanApprovalImagePaste,
      onCancel: input.cancelPlanApproval,
      onSubmit: (value) => {
        if (value === "stay") {
          input.resolvePlan("stay");
          return;
        }
        input.resolvePlan("continue", planApprovalPermissionMode(value, input.isFullAccessModeAvailable === true), input.planApprovalAcceptFeedback(), { clearContext: planApprovalClearsContext(value) });
      },
      onPromptSubmit: (text, _focusedValue, images) => {
        input.resolvePlan("stay", "default", input.planApprovalPromptFeedback(text, images));
      }
    };
  }
  if (input.mode === "confirm_interrupt") {
    const options = [
      { label: "Interrupt run", value: "interrupt" },
      { label: "Keep running", value: "stay" }
    ];
    const selectedValue = options[0].value;
    return { title: "Stop current run?", options, selectedValue, onSubmit: (value) => input.resolveInterrupt(value === "interrupt" ? "interrupt" : "stay") };
  }
  return undefined;
}


export function buildCommandMenuChoice(input: {
  state: CommandMenuState;
  diagnostics: RuntimeDiagnostics;
  mcpRuntime?: McpRuntime;
  statuslineElements: StatusLineElement[];
  setStatuslineElements: (elements: StatusLineElement[]) => void;
  setCommandMenu: (state: CommandMenuState | undefined) => void;
  closeCommandMenu: (message: string) => void;
  runMcpAction: (action: McpMenuAction, serverName?: string) => Promise<void>;
  pendingSkillNames?: string[];
  toggleSkillAvailability?: (skillName: string, disabled: boolean) => Promise<void> | void;
}): InteractionChoice | undefined {
  const state = input.state;
  if (state.kind === "skills:list") {
    return buildSkillsListChoice({ skills: input.diagnostics.skills, pendingSkillNames: input.pendingSkillNames, onSelect: (skillName) => input.setCommandMenu({ kind: "skills:detail", skillName }), onToggle: (skillName, disabled) => { void input.toggleSkillAvailability?.(skillName, disabled); }, onCancel: () => input.closeCommandMenu("Skills dialog dismissed") });
  }
  if (state.kind === "skills:detail") {
    const skill = input.diagnostics.skills.find((candidate) => candidate.name === state.skillName);
    return skill ? buildSkillsDetailChoice({ skill, onBack: () => input.setCommandMenu({ kind: "skills:list" }), onCancel: () => input.closeCommandMenu("Skills dialog dismissed") }) : undefined;
  }
  if (state.kind === "statusline") {
    return buildStatuslineChoice({
      selectedElements: input.statuslineElements,
      onChange: input.setStatuslineElements,
      onClose: () => input.closeCommandMenu("Statusline dialog dismissed")
    });
  }
  if (state.kind === "mcp:list") {
    return buildMcpListChoice({ servers: input.diagnostics.mcp, onSelect: (serverName) => input.setCommandMenu({ kind: "mcp:server", serverName }), onAction: (action, serverName) => { void input.runMcpAction(action, serverName); }, onCancel: () => input.closeCommandMenu("MCP dialog dismissed") });
  }
  if (state.kind === "mcp:server") {
    const server = input.diagnostics.mcp.find((candidate) => candidate.name === state.serverName);
    return server ? buildMcpServerChoice({ server, tools: input.mcpRuntime?.listToolDiagnostics(state.serverName) ?? [], onSelectTools: () => input.setCommandMenu({ kind: "mcp:tools", serverName: state.serverName }), onAction: (action, serverName) => { void input.runMcpAction(action, serverName); }, onBack: () => input.setCommandMenu({ kind: "mcp:list" }), onCancel: () => input.closeCommandMenu("MCP dialog dismissed") }) : undefined;
  }
  if (state.kind === "mcp:tools") {
    return buildMcpToolsChoice({ server: state.serverName, tools: input.mcpRuntime?.listToolDiagnostics(state.serverName) ?? [], onSelect: (toolName) => input.setCommandMenu({ kind: "mcp:toolDetail", serverName: state.serverName, toolName }), onBack: () => input.setCommandMenu({ kind: "mcp:server", serverName: state.serverName }), onCancel: () => input.closeCommandMenu("MCP dialog dismissed") });
  }
  const tool = input.mcpRuntime?.listToolDiagnostics(state.serverName).find((candidate) => candidate.name === state.toolName);
  return tool ? buildMcpToolDetailChoice({ tool, onBack: () => input.setCommandMenu({ kind: "mcp:tools", serverName: state.serverName }), onCancel: () => input.closeCommandMenu("MCP dialog dismissed") }) : undefined;
}

function helpDetailText(): string {
  return [
    "Keyboard shortcuts:",
    "  Enter submit · Shift+Enter/Ctrl+Enter newline",
    "  Shift+Tab cycle mode or approve selected action",
    "  Ctrl+O transcript · Ctrl+G edit plan/focused text",
    "  Esc cancel · Ctrl+C stop current run or copy selection · Ctrl+Shift+C/terminal Cmd+C copy selection",
    "",
    "Slash commands:",
    "  /help show this help",
    "  /plan [open|text] Plan Mode, show/open plan, or send plan text",
    "  /skills list available skills",
    "  /mcp list and manage MCP servers",
    "  /mcp enable|disable [server-name] toggle MCP servers",
    "  /mcp reconnect <server-name> reconnect an MCP server",
    "  /statusline configure the bottom statusline",
    "  /clear clear visible context · /resume [session] resume",
    "  /new new session · /model <model> switch · /permissions permissions"
  ].join("\n");
}


function parseStatuslineArgs(args: string[], current: StatusLineElement[]): { elements?: StatusLineElement[]; text: string; detailText: string } {
  const raw = args.join(" ").trim();
  const available = availableStatusLineElements.join(", ");
  if (!raw) {
    return {
      text: "Statusline",
      detailText: `Current: ${current.join(", ") || "none"}\nAvailable: ${available}\nUsage: /statusline ${available}\nUse /statusline default to reset.`
    };
  }
  if (raw === "default") {
    return {
      elements: defaultStatusLineElements,
      text: "Statusline reset",
      detailText: `Current: ${defaultStatusLineElements.join(", ")}`
    };
  }
  const requested = raw === "all" ? availableStatusLineElements : raw.split(/[,\s]+/).filter(Boolean);
  const invalid = requested.filter((item) => !isStatusLineElement(item));
  if (invalid.length) {
    return {
      text: "Statusline unchanged",
      detailText: `Unknown element: ${invalid.join(", ")}\nAvailable: ${available}`
    };
  }
  const elements = uniqueStatuslineElements(requested as StatusLineElement[]);
  return {
    elements,
    text: "Statusline updated",
    detailText: `Current: ${elements.join(", ") || "none"}`
  };
}


function PlanApprovalOverlay({
  review,
  planFilePath,
  editorName,
  maxDocumentLines,
  scrollOffset
}: {
  review: NonNullable<TuiState["pendingReview"]>;
  planFilePath?: string;
  editorName?: string;
  maxDocumentLines: number;
  scrollOffset: number;
}) {
  const empty = review.empty === true || !review.document.trim();
  const title = empty ? "Exit plan mode?" : "Ready to code?";
  const detail = empty
    ? "Einstein wants to exit plan mode"
    : planApprovalDetail({
        requestedPermissions: review.requestedPermissions,
        savedMessage: review.savedMessage,
        planFilePath,
        editorName
      });
  const documentTitle = empty ? "Plan file:" : "Here is Einstein's plan:";
  const document = planApprovalOverlayDocument(review);
  const lines = document.split(/\r?\n/);
  const maxLines = Math.max(1, maxDocumentLines);
  const canScroll = lines.length > maxLines;
  const maxOffset = Math.max(0, lines.length - maxLines);
  const offset = canScroll ? Math.max(0, Math.min(maxOffset, scrollOffset)) : 0;
  const visible = lines.slice(offset, offset + maxLines);
  const hiddenBefore = canScroll ? offset : 0;
  const hiddenAfter = canScroll ? Math.max(0, lines.length - offset - visible.length) : Math.max(0, lines.length - visible.length);
  const separator = "╌".repeat(72);
  return (
    <Box flexDirection="column">
      <Box marginBottom={1} flexDirection="column">
        <Text color="yellow">{title}</Text>
        {detail.split(/\r?\n/).map((line, index) => (
          <Text key={index} dimColor wrap="wrap">{line || " "}</Text>
        ))}
      </Box>
      <Text wrap="wrap">{documentTitle}</Text>
      {planFilePath ? <Text dimColor wrap="wrap">{`Plan saved to: ${planFilePath} · /plan to edit`}</Text> : null}
      <Box flexDirection="column" paddingX={1} overflow="hidden">
        <Text dimColor>{separator}</Text>
        {canScroll ? <Text dimColor>{`Lines ${offset + 1}-${offset + visible.length}/${lines.length} · PageUp/PageDown or mouse wheel`}</Text> : null}
        {hiddenBefore ? <Text dimColor>{`... ${hiddenBefore} lines above`}</Text> : null}
        {visible.map((line, index) => <PlanApprovalOverlayLine key={`${offset}:${index}`} line={line} />)}
        {hiddenAfter ? <Text dimColor>{`... ${hiddenAfter} lines below`}</Text> : null}
        <Text dimColor>{separator}</Text>
      </Box>
    </Box>
  );
}

function planApprovalOverlayMaxDocumentLines(review: NonNullable<TuiState["pendingReview"]>, height: number): number {
  const empty = review.empty === true || !review.document.trim();
  const detail = empty
    ? "Einstein wants to exit plan mode"
    : planApprovalDetail({
        requestedPermissions: review.requestedPermissions,
        savedMessage: review.savedMessage,
        planFilePath: review.planFilePath
      });
  const document = planApprovalOverlayDocument(review);
  const documentLines = document.split(/\r?\n/).length;
  const fixedRows = 1 + detail.split(/\r?\n/).length + 1 + 1 + (review.planFilePath ? 1 : 0) + 2;
  const available = Math.max(1, height - fixedRows);
  if (documentLines <= available) return documentLines;
  return Math.max(1, available - 3);
}

function planApprovalOverlayDocument(review: NonNullable<TuiState["pendingReview"]>): string {
  return review.document || "No plan found. Please write your plan to the plan file first.";
}

function PlanApprovalOverlayLine({ line }: { line: string }) {
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return <Text bold wrap="wrap">{line}</Text>;
  return <Text wrap="wrap">{line || " "}</Text>;
}

function isStatusLineElement(value: string): value is StatusLineElement {
  return (availableStatusLineElements as string[]).includes(value);
}

function uniqueStatuslineElements(elements: StatusLineElement[]): StatusLineElement[] {
  return elements.filter((element, index) => elements.indexOf(element) === index);
}

function isPlanSessionAcceptingInput(plan: PlanSessionState | undefined): boolean {
  return Boolean(plan && plan.mode !== "inactive" && plan.mode !== "waiting_approval");
}

function planApprovalDocument(document: string, planFilePath?: string): string {
  return planFilePath ? `Plan saved to: ${compactPlanApprovalPath(planFilePath)} · /plan to edit\n${document}` : document;
}

function compactPlanApprovalPath(planFilePath: string): string {
  const maxLength = 80;
  if (planFilePath.length <= maxLength) return planFilePath;
  return `${planFilePath.slice(0, 20)}...${planFilePath.slice(-(maxLength - 23))}`;
}

function planApprovalPermissionMode(value: string, isFullAccessModeAvailable = false): PermissionMode {
  if (value === "yes-full-access" || value === "yes-full-access-clear-context") return "fullAccess";
  if (value === "yes-default-keep-context" && isFullAccessModeAvailable) return "fullAccess";
  return "default";
}

function planApprovalClearsContext(value: string): boolean {
  return value === "yes-default-clear-context" || value === "yes-full-access-clear-context";
}

function buildPlanApprovalOptions(
  showClearContext: boolean,
  usedPercent: number | null,
  isFullAccessModeAvailable: boolean,
  onFeedbackChange: (text: string) => void
): InteractionChoice["options"] {
  const options: InteractionChoice["options"] = [];
  const usedLabel = usedPercent !== null ? ` (${usedPercent}% used)` : "";
  if (showClearContext) {
    options.push(isFullAccessModeAvailable
      ? { label: `Yes, clear context${usedLabel} and use full access`, value: "yes-full-access-clear-context" }
      : { label: `Yes, clear context${usedLabel}`, value: "yes-default-clear-context" });
  }
  options.push(
    isFullAccessModeAvailable
      ? { label: "Yes, and use full access", value: "yes-full-access" }
      : { label: "Yes, continue", value: "yes-default-keep-context" },
    {
      type: "input",
      label: "No, keep planning",
      value: "stay",
      placeholder: "Tell Einstein what to change",
      description: "shift+tab to approve with this feedback",
      showLabelWithValue: true,
      labelValueSeparator: ": ",
      onChange: onFeedbackChange
    }
  );
  return options;
}

function planApprovalFastAccept(empty: boolean, showClearContext: boolean, isFullAccessModeAvailable = false): { permissionMode: PermissionMode; clearContext: boolean } {
  if (empty) return { permissionMode: isFullAccessModeAvailable ? "fullAccess" : "default", clearContext: false };
  const value = showClearContext
    ? (isFullAccessModeAvailable ? "yes-full-access-clear-context" : "yes-default-clear-context")
    : (isFullAccessModeAvailable ? "yes-full-access" : "yes-default-keep-context");
  return {
    permissionMode: planApprovalPermissionMode(value, isFullAccessModeAvailable),
    clearContext: planApprovalClearsContext(value)
  };
}

function planApprovalDetail(input: {
  requestedPermissions?: PlanRequestedPermission[];
  savedMessage?: string;
  planFilePath?: string;
  editorName?: string;
}): string {
  const lines: string[] = [];
  if (input.requestedPermissions?.length) {
    lines.push(
      "Requested permissions:",
      ...input.requestedPermissions.map((permission) => `  · ${permission.tool}(prompt: ${permission.prompt})`)
    );
  }
  lines.push("Einstein has written up a plan and is ready to execute. Would you like to proceed?");
  if (input.savedMessage) lines.push(input.savedMessage);
  if (input.editorName) lines.push(`ctrl-g to edit in ${input.editorName}`);
  return lines.join("\n");
}
function displayPlanFilePath(planFilePath: string, cwd: string): string {
  const relativePath = relative(cwd, planFilePath);
  if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) return relativePath;
  return planFilePath;
}

async function recoverMissingPlanSession(input: {
  sessionId: string;
  cwd: string;
  planFilePath: string;
  messages: ModelMessage[];
}): Promise<PlanSessionState | undefined> {
  const planFilePath = input.planFilePath;
  const document = await readPlanOrRecoverFromTranscript({ planFilePath, cwd: input.cwd, messages: input.messages });
  if (document === undefined) return undefined;
  return {
    mode: document.trim() && hasExitPlanModeCall(input.messages) ? "waiting_approval" : "planning",
    sessionId: input.sessionId,
    planFilePath,
    prePlanMode: "default",
    originalInput: { request: firstUserText(input.messages) },
    feedbackMessages: []
  };
}

function hasExitPlanModeCall(messages: ModelMessage[]): boolean {
  return messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.name === "ExitPlanMode"));
}

function firstUserText(messages: ModelMessage[]): string {
  const content = messages.find((message) => message.role === "user" && !isRuntimeAttachmentMessage(message))?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
  return "";
}

function selectPlanProvider(input: {
  config?: AgentTeamConfig;
  workflowId?: string;
  providerFactory?: (providerId: string) => ModelProvider;
}): { provider: ModelProvider; model: string; effort: string; contextWindow?: number } | undefined {
  if (!input.config || !input.providerFactory) return undefined;
  const providerId = input.config.providers.default
    ? "default"
    : input.workflowId
      ? input.config.workflows[input.workflowId]?.nodes[0]?.provider
      : Object.keys(input.config.providers)[0];
  if (!providerId) return undefined;
  const providerConfig = input.config.providers[providerId];
  if (!providerConfig) return undefined;
  const registry = modelRegistryFromProviderConfig(providerConfig);
  const model = resolveModelForWorkflowNode({
    provider: providerConfig,
    permissionMode: "plan",
    planModel: providerConfig.plan_model,
    registry
  });
  const effort = resolveEffortForWorkflowNode({ provider: providerConfig });
  return {
    provider: input.providerFactory(providerId),
    model,
    effort,
    contextWindow: getModelContextWindow(model, registry)
  };
}

function contextUsedPercent(usage: ModelUsage | undefined, contextWindow: number | undefined): number | undefined {
  if (!usage?.inputTokens || !contextWindow) return undefined;
  return Math.max(0, Math.round((usage.inputTokens / contextWindow) * 100));
}

function buildQuestionChoice(input: {
  questions: unknown[];
  isPlanQuestion?: boolean;
  planFilePath?: string;
  resolveQuestion: (answer: unknown) => void;
  editQuestionText?: ExternalTextEditor;
  imagesByQuestion?: Record<string, SelectImageAttachment[]>;
  addImage?: (question: string, image: Omit<SelectImageAttachment, "id">) => void;
  removeImage?: (question: string, id: number) => void;
  resolveImagePaste?: (value: string) => Promise<{ text: string; images: Array<Omit<SelectImageAttachment, "id">> }>;
}): InteractionChoice | undefined {
  const review = submitQuestionReviewData(input.questions[0]);
  if (review) {
    const options = [
      { label: "Submit answers", value: "__submit_answers__" },
      { label: "Cancel", value: "__cancel_question__" }
    ];
    return {
      title: "Review your answers",
      detail: review.detail,
      questionNavigation: questionNavigationData(review.questions, review.questions.length, review.answers),
      options,
      selectedValue: options[0].value,
      onCancel: () => input.resolveQuestion({ type: "__cancel_question__" }),
      onNavigate: (direction) => input.resolveQuestion({ type: direction === "next" ? nextQuestionNavigationValue : previousQuestionNavigationValue }),
      onSubmit: (value) => input.resolveQuestion({ type: value })
    };
  }
  const question = input.questions.find((item) => questionOptions(item).length > 0);
  if (!question) return undefined;
  const id = questionId(question);
  const questionKey = questionText(question);
  const imageAttachments = input.imagesByQuestion?.[questionKey] ?? [];
  let freeformText = "";
  const baseOptions = questionOptions(question);
  const hasPreview = baseOptions.some((option) => typeof option.preview === "string" && option.preview.trim());
  const progress = questionProgress(question);
  const planDetail = input.isPlanQuestion && input.planFilePath && !hasPreview ? `Planning: ${input.planFilePath}` : undefined;
  const options: InteractionChoice["options"] = baseOptions.map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description,
    preview: option.preview,
    disabled: option.disabled
  }));
  if (questionAllowsFreeform(question) && !hasPreview) {
    options.push({
      type: "input" as const,
      label: "Other",
      value: otherQuestionOptionValue,
      placeholder: questionIsMultiSelect(question) ? "Type something" : "Type something.",
      showLabelWithValue: true,
      onChange: (value: string) => {
        freeformText = value;
      }
    });
  }
  if (progress && progress.index > 0 && !questionIsMultiSelect(question)) {
    options.push({ label: "Previous question", value: previousQuestionOptionValue });
  }
  const footerActions = input.isPlanQuestion
    ? [
        { label: "Chat about this", value: respondToClaudeQuestionValue },
        { label: "Skip interview and plan immediately", value: finishPlanInterviewQuestionValue }
      ]
    : undefined;
  return {
    title: progress ? `Question ${progress.index + 1}/${progress.count}: ${questionText(question)}` : questionText(question),
    detail: planDetail,
    questionNavigation: progress ? questionNavigationData(questionsFromQuestion(question), progress.index, answersFromQuestion(question)) : undefined,
    options,
    footerActions,
    selectedValue: options[0]?.value ?? "",
    multiSelect: questionIsMultiSelect(question),
    selectedValues: [],
    submitButtonText: questionIsMultiSelect(question) ? (progress && progress.index < progress.count - 1 ? "Next" : "Submit") : undefined,
    allowPromptInput: questionAllowsFreeform(question),
    onCancel: () => input.resolveQuestion({ type: "__cancel_question__" }),
    imageAttachments,
    onImagePaste: input.addImage ? (image) => input.addImage?.(questionKey, image) : undefined,
    onRemoveImage: input.removeImage ? (imageId) => input.removeImage?.(questionKey, imageId) : undefined,
    resolveImagePaste: input.resolveImagePaste,
    onSubmit: (value) => {
      if (value === previousQuestionOptionValue) {
        input.resolveQuestion({ type: previousQuestionOptionValue });
        return;
      }
      if (value === respondToClaudeQuestionValue || value === finishPlanInterviewQuestionValue) {
        input.resolveQuestion({ type: value });
        return;
      }
      if (value === otherQuestionOptionValue) {
        input.resolveQuestion({ ...questionAnswerContext(question), answer: questionFreeformAnswer(freeformText, imageAttachments), question_id: id, option_value: otherQuestionOptionValue });
        return;
      }
      const selected = questionOptions(question).find((option) => option.value === value);
      input.resolveQuestion({ ...questionAnswerContext(question), answer: selected?.label ?? value, question_id: id, option_value: value, ...(selected?.preview ? { preview: selected.preview } : {}) });
    },
    onNavigate: progress ? (direction) => input.resolveQuestion({ type: direction === "next" ? nextQuestionNavigationValue : previousQuestionNavigationValue }) : undefined,
    onPromptSubmit: hasPreview
      ? (text, focusedValue) => {
          const selected = questionOptions(question).find((option) => option.value === focusedValue) ?? questionOptions(question)[0];
          input.resolveQuestion({
            answer: selected?.label ?? text,
            question_id: id,
            option_value: selected?.value,
            ...(selected?.preview || text.trim() ? { annotations: { ...(selected?.preview ? { preview: selected.preview } : {}), ...(text.trim() ? { notes: text.trim() } : {}) } } : {})
          });
        }
      : undefined,
    editInputText: input.editQuestionText,
    editPromptText: hasPreview ? input.editQuestionText : undefined,
    onSubmitValues: (values) => {
      const answerValues = values.filter((value) => value !== respondToClaudeQuestionValue && value !== finishPlanInterviewQuestionValue);
      const selected = questionOptions(question).filter((option) => answerValues.includes(option.value));
      const answer = selected.map((option) => option.label);
      if (answerValues.includes(otherQuestionOptionValue)) {
        const otherAnswer = questionFreeformAnswer(freeformText, imageAttachments);
        if (otherAnswer.trim()) answer.push(otherAnswer);
      }
      input.resolveQuestion({
        answer,
        question_id: id,
        option_values: answerValues
      });
    }
  };
}

const otherQuestionOptionValue = "__other__";
const previousQuestionOptionValue = "__previous_question__";
const previousQuestionNavigationValue = "__navigate_previous_question__";
const nextQuestionNavigationValue = "__navigate_next_question__";
const respondToClaudeQuestionValue = "__respond_to_claude__";
const finishPlanInterviewQuestionValue = "__finish_plan_interview__";

function questionFreeformAnswer(text: string, images: SelectImageAttachment[] = []): string {
  const answer = text.trim();
  if (!images.length) return answer;
  return answer ? `${answer} (Image attached)` : "(Image attached)";
}

type QuestionOption = {
  label: string;
  value: string;
  description?: string;
  preview?: string;
  disabled?: boolean;
};

function questionOptions(question: unknown): QuestionOption[] {
  if (!question || typeof question !== "object") return [];
  const options = (question as { options?: unknown }).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option, index) => {
    if (!option || typeof option !== "object") return [];
    const value = option as Record<string, unknown>;
    const label = typeof value.label === "string" && value.label.trim() ? value.label : typeof value.value === "string" ? value.value : "";
    if (!label) return [];
    return [{
      label,
      value: typeof value.value === "string" && value.value.trim() ? value.value : String(index + 1),
      description: typeof value.description === "string" ? value.description : undefined,
      preview: typeof value.preview === "string" ? value.preview : undefined,
      disabled: value.disabled === true
    }];
  });
}

function questionId(question: unknown): string | undefined {
  return question && typeof question === "object" && typeof (question as { id?: unknown }).id === "string"
    ? (question as { id: string }).id
    : undefined;
}

function questionText(question: unknown): string {
  if (!question || typeof question !== "object") return "Waiting for user input";
  const text = (question as { text?: unknown }).text;
  if (typeof text === "string" && text.trim()) return text;
  const tuiCodeQuestion = (question as { question?: unknown }).question;
  return typeof tuiCodeQuestion === "string" && tuiCodeQuestion.trim() ? tuiCodeQuestion : "Waiting for user input";
}

function questionHeader(question: unknown, index: number): string {
  if (question && typeof question === "object") {
    const header = (question as { header?: unknown }).header;
    if (typeof header === "string" && header.trim()) return header;
  }
  return `Q${index + 1}`;
}

function questionAllowsFreeform(question: unknown): boolean {
  if (!question || typeof question !== "object") return true;
  return (question as { allow_freeform?: unknown }).allow_freeform !== false;
}

function questionIsMultiSelect(question: unknown): boolean {
  return Boolean(question && typeof question === "object" && (question as { multiSelect?: unknown }).multiSelect === true);
}
function layoutMetrics(input: { terminalRows: number; choice?: InteractionChoice; planReview?: { document: string }; activityStatusVisible?: boolean }): { mainHeight: number; planReviewHeight: number } {
  const headerRows = 3;
  const flowRows = 4;
  const promptRows = input.choice ? 0 : input.activityStatusVisible ? 8 : 6;
  const choiceRows = input.choice ? estimateChoiceRows(input.choice) : 0;
  const available = Math.max(1, input.terminalRows - headerRows - flowRows - promptRows - choiceRows);
  const planReviewHeight = input.planReview ? Math.max(0, Math.min(12, available - 1)) : 0;
  const mainHeight = Math.max(1, available - planReviewHeight);
  return { mainHeight, planReviewHeight };
}

function estimateChoiceRows(choice: InteractionChoice): number {
  const borderRows = 2;
  const titleRows = choice.hideTitle ? 0 : 1;
  const navigationRows = choice.questionNavigation ? 1 : 0;
  const detailRows = choice.hideTitle ? 0 : choice.detail ? choice.detail.split(/\r?\n/).length : 0;
  const documentRows = choice.documentBlock
    ? (choice.documentBlock.title ? 1 : 0) +
      2 +
      Math.min(choice.documentBlock.text.split(/\r?\n/).length, choice.documentBlock.maxLines ?? 18) +
      (choice.documentBlock.scrollable && choice.documentBlock.text.split(/\r?\n/).length > (choice.documentBlock.maxLines ?? 18) ? 3 : choice.documentBlock.text.split(/\r?\n/).length > (choice.documentBlock.maxLines ?? 18) ? 1 : 0) +
      1
    : 0;
  const visibleOptionRows = choice.multiSelect
    ? Math.min(choice.options.length + 1, choice.visibleOptionCount ?? 7)
    : Math.min(choice.options.length, choice.visibleOptionCount ?? 7);
  const footerRows = choice.footerActions?.length ? choice.footerActions.length + 1 : 0;
  const previewRows = choice.options.some((option) => typeof option.preview === "string" && option.preview.trim())
    ? 9
    : 0;
  return borderRows + navigationRows + titleRows + detailRows + documentRows + Math.max(visibleOptionRows + footerRows, previewRows);
}

export function jumpMainScrollBy(scroll: Pick<ScrollBoxHandle, "getScrollHeight" | "getViewportHeight" | "getScrollTop" | "getPendingDelta" | "scrollTo" | "scrollToBottom">, delta: number): boolean {
  const max = Math.max(0, scroll.getScrollHeight() - scroll.getViewportHeight());
  const target = scroll.getScrollTop() + scroll.getPendingDelta() + delta;
  if (target >= max) {
    scroll.scrollTo(max);
    scroll.scrollToBottom();
    return true;
  }
  scroll.scrollTo(Math.max(0, target));
  return false;
}
export function scrollMainDown(scroll: Pick<ScrollBoxHandle, "getScrollHeight" | "getViewportHeight" | "getScrollTop" | "getPendingDelta" | "scrollBy" | "scrollToBottom">, amount: number): boolean {
  const max = Math.max(0, scroll.getScrollHeight() - scroll.getViewportHeight());
  const effectiveTop = scroll.getScrollTop() + scroll.getPendingDelta();
  if (effectiveTop + amount >= max) {
    scroll.scrollToBottom();
    return true;
  }
  scroll.scrollBy(amount);
  return false;
}
export function scrollMainUp(scroll: Pick<ScrollBoxHandle, "getScrollTop" | "getPendingDelta" | "scrollBy" | "scrollTo">, amount: number): void {
  const effectiveTop = scroll.getScrollTop() + scroll.getPendingDelta();
  if (effectiveTop - amount <= 0) {
    scroll.scrollTo(0);
    return;
  }
  scroll.scrollBy(-amount);
}
