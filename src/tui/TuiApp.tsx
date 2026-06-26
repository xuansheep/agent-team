import React, { useEffect, useRef, useState } from "react";
import { Box, ScrollBox, Text, useApp, useHasSelection, useInput, useSelection, useStdin, useStdout } from "./ink.js";
import type { ScrollBoxHandle } from "./ink.js";
import { AgentTeamConfig } from "../config/schema.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { WorkflowSession } from "../workflow/session.js";
import { initialTuiState, reduceStoredEvent, resetTuiRunState } from "./eventAdapter.js";
import { ensureRefableStdin } from "./inkStdin.js";
import { TuiState } from "./state.js";
import { Header } from "./components/Header.js";
import { InteractionArea, InteractionChoice } from "./components/InteractionArea.js";
import { PromptInputEvent, PromptInputMode } from "./components/PromptInput/types.js";
import { ResultPanel } from "./components/ResultPanel.js";
import { RunLogPanel } from "./components/RunLogPanel.js";
import { WorkflowFlowChart } from "./components/WorkflowFlowChart.js";
export function TuiApp({
  cwd,
  initialError,
  config,
  workflows = [],
  workflowId,
  engine,
  onExit
}: {
  cwd: string;
  initialError?: string;
  config?: AgentTeamConfig;
  workflows?: string[];
  workflowId?: string;
  engine?: WorkflowEngine;
  onExit?: () => void;
}) {
  const { exit } = useApp();
  const { stdin } = useStdin();
  const { stdout } = useStdout();
  const selection = useSelection();
  const hasSelection = useHasSelection();
  ensureRefableStdin(stdin);
  const terminalRows = stdout.rows && stdout.rows > 0 ? stdout.rows : 24;
  const exitTui = onExit ?? exit;
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(workflowId);
  const [state, setState] = useState<TuiState>(() => ({
    ...initialTuiState({ cwd }),
    mode: workflowId ? "input" as const : workflows.length > 1 ? "select_workflow" as const : "input" as const,
    workflowId
  }));
  const [queued, setQueued] = useState<string[]>([]);
  const [promptText, setPromptText] = useState("");
  const [transcriptMode, setTranscriptMode] = useState(false);
  const [choiceKey, setChoiceKey] = useState("");
  const mainScrollRef = useRef<ScrollBoxHandle>(null);
  const sessionRef = useRef<WorkflowSession>();
  const listeningSessionRef = useRef<WorkflowSession>();
  const canceledChoiceKeyRef = useRef<string>();
  const selectWorkflow = (workflow: string) => {
    setSelectedWorkflowId(workflow);
    setState((current) => ({ ...current, workflowId: workflow, mode: "input" }));
  };
  const failUi = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState((current) => ({ ...current, mode: "failed", error: message }));
  };
  const interruptAndExit = () => {
    void sessionRef.current?.interrupt().finally(() => exitTui());
  };
  const handleCtrlC = () => {
    const behavior = resolveCtrlCBehavior(state.mode, Boolean(sessionRef.current), hasSelection || selection.hasSelection());
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
  const resetSession = () => {
    sessionRef.current = undefined;
    setQueued([]);
    setState((current) => ({
      ...initialTuiState({ cwd: current.cwd }),
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
          setState((current) => reduceStoredEvent({ ...current, runId: session.runId, workflowId: nextWorkflowId }, event));
        }
      } finally {
        if (listeningSessionRef.current === session) listeningSessionRef.current = undefined;
      }
    })();
  };
  const attachSession = (session: WorkflowSession, nextWorkflowId: string) => {
    sessionRef.current = session;
    mainScrollRef.current?.scrollToBottom();
    setState((current) => resetTuiRunState(current, { workflowId: nextWorkflowId, runId: session.runId }));
    listenSession(session, nextWorkflowId);
    void session.result
      .then((result) => {
        setState((current) => ({
          ...current,
          mode: workflowResultMode(result.status),
          workflowId: nextWorkflowId,
          runId: session.runId
        }));
      })
      .catch((error) => failUi(error));
  };
  const startRun = async (text: string) => {
    if (!config || !engine) {
      failUi("TUI is missing workflow configuration");
      return;
    }
    if (!selectedWorkflowId) {
      setState((current) => ({ ...current, mode: "select_workflow" }));
      return;
    }
    try {
      const session = await engine.startInteractive(config, selectedWorkflowId, { request: text, images: [] });
      attachSession(session, selectedWorkflowId);
    } catch (error) {
      failUi(error);
    }
  };
  const resumeRun = async (runId: string) => {
    if (!config || !engine) {
      failUi("TUI is missing workflow configuration");
      return;
    }
    try {
      const session = await engine.resumeInteractive(config, runId);
      setSelectedWorkflowId(session.state.workflow_id);
      attachSession(session, session.state.workflow_id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({ ...current, mode: "input", error: message, resumeRuns: [], pendingResumeRunId: undefined, modeBeforeConfirmation: undefined }));
    }
  };
  const continueSession = (text: string) => {
    const session = sessionRef.current;
    const nextWorkflowId = state.workflowId ?? selectedWorkflowId ?? session?.state.workflow_id;
    if (!session || !nextWorkflowId) {
      void startRun(text);
      return;
    }
    setState((current) => ({ ...current, mode: "running", error: undefined }));
    const continuation = session.continueWithInput({ request: text, images: [] });
    listenSession(session, nextWorkflowId);
    void continuation.catch((error) => failUi(error));
  };
  const openResumePicker = async () => {
    if (!engine) {
      failUi("TUI is missing workflow configuration");
      return;
    }
    try {
      const runs = await engine.listRuns({ limit: 30 });
      if (!runs.length) {
        setState((current) => ({ ...current, mode: "input", resumeRuns: [], error: "No sessions found" }));
        return;
      }
      setState((current) => ({ ...current, mode: "resume_picker", resumeRuns: runs, error: undefined }));
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
      setQueued((current) => [...current, event.text]);
      setState((current) => ({ ...current, timeline: [...current.timeline, `queued:${event.text}`] }));
      return;
    }
    if (event.type === "command") {
      if (event.name === "new") {
        if (isActiveSessionMode(state.mode)) setState((current) => ({ ...current, mode: "confirm_new", modeBeforeConfirmation: current.mode }));
        else resetSession();
      }
      if (event.name === "resume") {
        const runId = event.args[0];
        if (isActiveSessionMode(state.mode)) setState((current) => ({ ...current, mode: "confirm_resume", pendingResumeRunId: runId, modeBeforeConfirmation: current.mode }));
        else if (runId) void resumeRun(runId);
        else void openResumePicker();
      }
      return;
    }
    if (state.mode === "plan_revision") {
      setState((current) => ({ ...current, mode: "running", pendingReview: undefined, questions: [], error: undefined }));
      void sessionRef.current?.revisePlan({ answer: event.text }).catch((error) => failUi(error));
      return;
    }
    if (state.mode === "question") {
      setState((current) => ({ ...current, mode: "running", questions: [], error: undefined }));
      void sessionRef.current?.resumeWithUserInput({ answer: event.text }).catch((error) => failUi(error));
      return;
    }
    if (state.mode === "waiting_plan_review") {
      setState((current) => ({ ...current, mode: "plan_revision", questions: [], error: undefined }));
      void sessionRef.current?.revisePlan({ answer: event.text }).catch((error) => failUi(error));
      return;
    }
    if (state.mode === "permission" || state.mode === "confirm_interrupt" || state.mode === "confirm_new" || state.mode === "confirm_resume" || state.mode === "resume_picker" || state.mode === "select_workflow") return;
    if (state.mode === "paused" && state.runId) {
      continueSession(event.text);
      return;
    }
    if (state.runId || state.mode === "completed" || state.mode === "failed" || state.mode === "interrupted") {
      continueSession(event.text);
      return;
    }
    void startRun(event.text);
  };
  const currentAttempt = currentNodeAttempt(state);
  const workflowNodes = selectedWorkflowId
    ? config?.workflows[selectedWorkflowId]?.nodes.map((node) => ({ id: node.id, role: node.role, model: node.model ?? config.roles[node.role]?.default_model ?? config.providers[node.provider]?.default_model }))
    : undefined;
  const activeChoice = buildActiveChoice({
    mode: state.mode,
    workflows,
    permission: state.permissionRequests[0],
    review: state.pendingReview,
    questions: state.questions,
    selectWorkflow,
    resolvePermission: (requestId, decision) => {
      try {
        sessionRef.current?.permissions.resolve(requestId, decision);
      } catch (error) {
        failUi(error);
      }
    },
    resolvePlan: (decision) => {
      void sessionRef.current?.resumePlanReview(decision).catch((error) => failUi(error));
    },
    resolveQuestion: (answer) => {
      setState((current) => ({ ...current, mode: "running", questions: [], error: undefined }));
      void sessionRef.current?.resumeWithUserInput(answer).catch((error) => failUi(error));
    },
    resolveInterrupt: (decision) => {
      if (decision === "interrupt") interruptAndExit();
      else setState((current) => ({ ...current, mode: current.modeBeforeConfirmation ?? "running", modeBeforeConfirmation: undefined }));
    },
    resumeRuns: state.resumeRuns,
    resolveResume: (runId) => {
      setState((current) => ({ ...current, mode: "input", resumeRuns: [], error: undefined, pendingResumeRunId: undefined, modeBeforeConfirmation: undefined }));
      void resumeRun(runId);
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
    }
  });
  const nextChoiceKey = activeChoice ? `${state.mode}:${activeChoice.title}:${activeChoice.options.map((option) => option.value).join("|")}` : "";
  const cancelActiveChoice = (): boolean => {
    const action = resolveActiveChoiceCancel(state);
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
    void sessionRef.current?.resumePlanReview("stay").catch((error) => failUi(error));
    return true;
  };
  useEffect(() => {
    if (choiceKey === nextChoiceKey) return;
    setChoiceKey(nextChoiceKey);
    canceledChoiceKeyRef.current = undefined;
  }, [choiceKey, nextChoiceKey]);
  const layout = layoutMetrics({ terminalRows, choice: activeChoice });
  useInput((input, key, event) => {
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
    if (key.escape && cancelActiveChoice()) {
      event.stopImmediatePropagation();
      return;
    }
    if (input === "c" && key.ctrl) {
      handleCtrlC();
      event.stopImmediatePropagation();
      return;
    }
    const mainScroll = mainScrollRef.current;
    if (mainScroll && key.wheelUp) {
      scrollMainUp(mainScroll, 3);
      return;
    }
    if (mainScroll && key.wheelDown) {
      scrollMainDown(mainScroll, 3);
      return;
    }
    if (activeChoice && (key.pageUp || key.pageDown || key.upArrow || key.downArrow || key.return)) return;
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
        <Text>Run agent-team init to create agent-team.yaml</Text>
      </Box>
    );
  }
  const promptMode: PromptInputMode =
    state.mode === "plan_revision"
      ? "running"
      : state.mode === "running" || state.mode === "permission" || state.mode === "question" || state.mode === "waiting_plan_review" || state.mode === "confirm_interrupt"
        ? state.mode
        : "input";
  const isLoading = state.mode === "running" || state.mode === "permission" || state.mode === "plan_revision";
  return (
    <Box flexDirection="column" height={terminalRows}>
      <Header cwd={cwd} workflowId={state.workflowId} runId={state.runId} />
      <WorkflowFlowChart workflowNodes={workflowNodes} nodes={state.nodes} currentNodeId={state.currentNodeId} />
      <ScrollBox ref={mainScrollRef} flexDirection="column" height={layout.mainHeight} stickyScroll>
        {state.mode === "select_workflow" ? <Text>Select workflow from the bottom interaction area</Text> : null}
        <RunLogPanel
          items={state.logMessages}
          currentNodeId={state.currentNodeId}
          currentAttempt={currentAttempt}
          detailMode={transcriptMode}
        />
        <ResultPanel mode={state.mode} error={state.error} runId={state.runId} />
      </ScrollBox>
      <InteractionArea
        choice={activeChoice}
        mode={promptMode}
        workflowId={state.workflowId}
        queued={queued}
        workflows={workflows}
        isLoading={isLoading}
        hasSelection={hasSelection}
        promptText={promptText}
        inputDisabled={transcriptMode}
        onPromptEvent={handlePromptEvent}
        onPromptTextChange={setPromptText}
      />
    </Box>
  );
}
export type ActiveChoiceCancelAction =
  | { type: "none" }
  | { type: "exit"; key: string }
  | { type: "restore_mode"; mode: TuiState["mode"]; key: string; clearPendingResumeRunId?: boolean; clearResumePicker?: boolean }
  | { type: "deny_permission"; requestId: string; key: string }
  | { type: "stay_plan"; key: string };
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
  if (state.mode === "waiting_plan_review") {
    const review = state.pendingReview;
    return review ? { type: "stay_plan", key: `plan:${review.nodeId}:${review.attempt}` } : { type: "none" };
  }
  if (state.mode === "confirm_interrupt") return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "running", key: "confirm_interrupt" };
  if (state.mode === "confirm_new") return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "running", key: "confirm_new" };
  if (state.mode === "confirm_resume") {
    const key = state.pendingResumeRunId ? `confirm_resume:${state.pendingResumeRunId}` : "confirm_resume";
    return { type: "restore_mode", mode: state.modeBeforeConfirmation ?? "running", clearPendingResumeRunId: true, key };
  }
  if (state.mode === "resume_picker") return { type: "restore_mode", mode: "input", clearResumePicker: true, key: "resume_picker" };
  if (state.mode === "select_workflow") return state.workflowId ? { type: "restore_mode", mode: "input", key: "select_workflow" } : { type: "exit", key: "select_workflow" };
  return { type: "none" };
}
export function resolveCtrlCBehavior(mode: TuiState["mode"], hasSession: boolean, hasSelection = false): "copy_selection" | "exit" | "confirm_interrupt" | "interrupt" {
  if (hasSelection) return "copy_selection";
  if (!hasSession || !isActiveSessionMode(mode)) return "exit";
  return mode === "confirm_interrupt" ? "interrupt" : "confirm_interrupt";
}
function isActiveSessionMode(mode: TuiState["mode"]): boolean {
  return mode === "running" || mode === "permission" || mode === "question" || mode === "waiting_plan_review" || mode === "plan_revision" || mode === "confirm_interrupt" || mode === "confirm_new" || mode === "confirm_resume";
}
function workflowResultMode(status: WorkflowSession["state"]["status"]): TuiState["mode"] {
  if (status === "pending") return "question";
  return "paused";
}
function currentNodeAttempt(state: TuiState): number | undefined {
  if (!state.currentNodeId) return undefined;
  for (let index = state.nodes.length - 1; index >= 0; index -= 1) {
    const node = state.nodes[index];
    if (node.nodeId === state.currentNodeId) return node.attempt;
  }
  return undefined;
}
function buildActiveChoice(input: {
  mode: TuiState["mode"];
  workflows: string[];
  permission?: TuiState["permissionRequests"][number];
  review?: TuiState["pendingReview"];
  questions: TuiState["questions"];
  resumeRuns: TuiState["resumeRuns"];
  selectWorkflow: (workflow: string) => void;
  resolvePermission: (requestId: string, decision: "allow_once" | "deny_once") => void;
  resolvePlan: (decision: "continue" | "stay") => void;
  resolveQuestion: (answer: unknown) => void;
  resolveInterrupt: (decision: "interrupt" | "stay") => void;
  resolveResume: (runId: string) => void;
  resolveNew: (decision: "new" | "stay") => void;
  resolvePendingResume: (decision: "resume" | "stay") => void;
}): InteractionChoice | undefined {
  if (input.mode === "select_workflow" && input.workflows.length) {
    const options = input.workflows.map((workflow) => ({ label: workflow, value: workflow }));
    const selectedValue = options[0]?.value ?? "";
    return { title: "Select workflow", options, selectedValue, onSubmit: input.selectWorkflow };
  }
  if (input.mode === "resume_picker" && input.resumeRuns.length) {
    const options = input.resumeRuns.map((run) => ({
      label: `${run.workflowId} ${run.status} ${run.inputPreview || run.runId}`,
      value: run.runId
    }));
    const selectedValue = options[0]?.value ?? "";
    return { title: "Resume workflow run", options, selectedValue, visibleOptionCount: 10, onSubmit: input.resolveResume };
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
  if (input.mode === "permission" && input.permission) {
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
    const questionChoice = buildQuestionChoice(input.questions, input.resolveQuestion);
    if (questionChoice) return questionChoice;
  }
  if (input.mode === "waiting_plan_review" && input.review) {
    const options = [
      { label: "Yes, approve and continue", value: "continue" },
      { label: "No, keep planning", value: "stay", type: "input" as const, placeholder: "Tell the agent what to change", showLabelWithValue: true, allowEmptySubmitToCancel: true, onChange: () => undefined }
    ];
    return { title: "Plan approval request", options, selectedValue: "continue", allowPromptInput: true, onSubmit: (value) => input.resolvePlan(value === "stay" ? "stay" : "continue") };
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

function buildQuestionChoice(questions: unknown[], resolveQuestion: (answer: unknown) => void): InteractionChoice | undefined {
  const question = questions.find((item) => questionOptions(item).length > 0);
  if (!question) return undefined;
  const id = questionId(question);
  const options = questionOptions(question).map((option) => ({
    label: option.label,
    value: option.value,
    description: option.description,
    disabled: option.disabled
  }));
  return {
    title: questionText(question),
    options,
    selectedValue: options[0]?.value ?? "",
    allowPromptInput: questionAllowsFreeform(question),
    onSubmit: (value) => {
      const selected = questionOptions(question).find((option) => option.value === value);
      resolveQuestion({ answer: selected?.label ?? value, question_id: id, option_value: value });
    }
  };
}

type QuestionOption = {
  label: string;
  value: string;
  description?: string;
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
  return typeof text === "string" && text.trim() ? text : "Waiting for user input";
}

function questionAllowsFreeform(question: unknown): boolean {
  if (!question || typeof question !== "object") return true;
  return (question as { allow_freeform?: unknown }).allow_freeform !== false;
}
function layoutMetrics(input: { terminalRows: number; choice?: InteractionChoice }): { mainHeight: number } {
  const headerRows = 3;
  const flowRows = 4;
  const promptRows = 5;
  const choiceRows = input.choice ? input.choice.options.length + 3 + (input.choice.detail ? 1 : 0) : 0;
  const mainHeight = Math.max(1, input.terminalRows - headerRows - flowRows - promptRows - choiceRows);
  return { mainHeight };
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
