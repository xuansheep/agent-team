import React, { useEffect, useRef, useState } from "react";
import { Box, ScrollBox, Text, useApp, useInput, useStdin, useStdout } from "./ink.js";
import type { ScrollBoxHandle } from "./ink.js";
import { AgentTeamConfig } from "../config/schema.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { WorkflowSession } from "../workflow/session.js";
import { initialTuiState, reduceStoredEvent, resetTuiRunState } from "./eventAdapter.js";
import { ensureRefableStdin } from "./inkStdin.js";
import { TuiState } from "./state.js";
import { Header } from "./components/Header.js";
import { InteractionArea, InteractionChoice } from "./components/InteractionArea.js";
import { PlanReviewPrompt } from "./components/PlanReviewPrompt.js";
import { PromptInputEvent, PromptInputMode } from "./components/PromptInput/types.js";
import { ResultPanel } from "./components/ResultPanel.js";
import { RunLogPanel } from "./components/RunLogPanel.js";
import { WorkflowFlowChart } from "./components/WorkflowFlowChart.js";
import { UserQuestionPrompt } from "./components/UserQuestionPrompt.js";

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
  const [logDetailMode, setLogDetailMode] = useState(false);
  const [choiceIndex, setChoiceIndex] = useState(0);
  const [choiceKey, setChoiceKey] = useState("");
  const mainScrollRef = useRef<ScrollBoxHandle>(null);
  const sessionRef = useRef<WorkflowSession>();

  const selectWorkflow = (workflow: string) => {
    setSelectedWorkflowId(workflow);
    setState((current) => ({ ...current, workflowId: workflow, mode: "input" }));
  };

  const failUi = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setState((current) => ({ ...current, mode: "failed", error: message }));
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
      sessionRef.current = session;
      mainScrollRef.current?.scrollToBottom();
      setState((current) => resetTuiRunState(current, { workflowId: selectedWorkflowId, runId: session.runId }));
      void (async () => {
        for await (const event of session.events) {
          setState((current) => reduceStoredEvent({ ...current, runId: session.runId, workflowId: selectedWorkflowId }, event));
        }
      })();
      void session.result
        .then((result) => {
          setState((current) => ({
            ...current,
            mode: result.status === "waiting_user" ? "question" : result.status,
            workflowId: selectedWorkflowId,
            runId: session.runId
          }));
        })
        .catch((error) => failUi(error));
    } catch (error) {
      failUi(error);
    }
  };

  const handlePromptEvent = (event: PromptInputEvent) => {
    if (event.type === "toggle_log_detail") {
      setLogDetailMode((current) => !current);
      return;
    }
    if (event.type === "cancel") {
      if (state.mode === "confirm_interrupt") setState((current) => ({ ...current, mode: "running" }));
      return;
    }
    if (event.type === "queue") {
      setQueued((current) => [...current, event.text]);
      setState((current) => ({ ...current, timeline: [...current.timeline, `queued:${event.text}`] }));
      return;
    }
    if (event.type === "command") {
      if (event.name === "run" && event.args[0] && workflows.includes(event.args[0])) selectWorkflow(event.args[0]);
      return;
    }
    if (state.mode === "plan_revision") {
      setState((current) => ({ ...current, mode: "running", pendingReview: undefined }));
      void sessionRef.current?.revisePlan({ answer: event.text }).catch((error) => failUi(error));
      return;
    }
    if (state.mode === "question") {
      void sessionRef.current?.resumeWithUserInput({ answer: event.text }).catch((error) => failUi(error));
      return;
    }
    if (state.mode === "waiting_plan_review" || state.mode === "permission" || state.mode === "confirm_interrupt" || state.mode === "select_workflow") return;
    void startRun(event.text);
  };

  const currentAttempt = currentNodeAttempt(state);
  const workflowNodes = selectedWorkflowId ? config?.workflows[selectedWorkflowId]?.nodes.map((node) => ({ id: node.id, role: node.role })) : undefined;
  const activeChoice = buildActiveChoice({
    mode: state.mode,
    workflows,
    choiceIndex,
    permission: state.permissionRequests[0],
    review: state.pendingReview,
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
    resolveInterrupt: (decision) => {
      if (decision === "interrupt") void sessionRef.current?.interrupt();
      else setState((current) => ({ ...current, mode: "running" }));
    }
  });
  const nextChoiceKey = activeChoice ? `${state.mode}:${activeChoice.title}:${activeChoice.options.map((option) => option.value).join("|")}` : "";

  useEffect(() => {
    if (choiceKey === nextChoiceKey) return;
    setChoiceKey(nextChoiceKey);
    setChoiceIndex(0);
  }, [choiceKey, nextChoiceKey]);

  const layout = layoutMetrics({ terminalRows, choice: activeChoice });

  useInput((input, key) => {
    if (input === "c" && key.ctrl) {
      const behavior = resolveCtrlCBehavior(state.mode, Boolean(sessionRef.current));
      if (behavior === "exit") {
        exitTui();
        return;
      }
      if (behavior === "confirm_interrupt") {
        setState((current) => ({ ...current, mode: "confirm_interrupt" }));
        return;
      }
      if (behavior === "interrupt") void sessionRef.current?.interrupt();
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
    if (mainScroll && key.pageUp) {
      jumpMainScrollBy(mainScroll, -Math.max(1, Math.floor(mainScroll.getViewportHeight() / 2)));
      return;
    }
    if (mainScroll && key.pageDown) {
      jumpMainScrollBy(mainScroll, Math.max(1, Math.floor(mainScroll.getViewportHeight() / 2)));
      return;
    }
    if (!activeChoice) return;
    if (key.upArrow || input === "\u001b[A") {
      setChoiceIndex((current) => (current === 0 ? activeChoice.options.length - 1 : current - 1));
      return;
    }
    if (key.downArrow || input === "\u001b[B") {
      setChoiceIndex((current) => (current + 1) % activeChoice.options.length);
      return;
    }
    if (key.return || input === "\r" || input === "\n") {
      activeChoice.onSubmit(activeChoice.selectedValue);
      return;
    }
    const shortcut = activeChoice.options.find((option) => option.shortcut?.toLowerCase() === input.toLowerCase());
    if (shortcut) activeChoice.onSubmit(shortcut.value);
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
    state.mode === "running" || state.mode === "permission" || state.mode === "question" || state.mode === "waiting_plan_review" || state.mode === "confirm_interrupt"
      ? state.mode
      : "input";
  const isLoading = state.mode === "running" || state.mode === "permission" || state.mode === "waiting_plan_review";

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
          detailMode={logDetailMode}
        />
        <PlanReviewPrompt review={state.pendingReview} />
        <UserQuestionPrompt questions={state.questions} />
        <ResultPanel mode={state.mode} error={state.error} runId={state.runId} />
      </ScrollBox>
      <InteractionArea
        choice={activeChoice}
        mode={promptMode}
        workflowId={state.workflowId}
        queued={queued}
        workflows={workflows}
        isLoading={isLoading}
        onPromptEvent={handlePromptEvent}
      />
    </Box>
  );
}

export function resolveCtrlCBehavior(mode: TuiState["mode"], hasSession: boolean): "exit" | "confirm_interrupt" | "interrupt" {
  if (!hasSession || !isActiveSessionMode(mode)) return "exit";
  return mode === "confirm_interrupt" ? "interrupt" : "confirm_interrupt";
}

function isActiveSessionMode(mode: TuiState["mode"]): boolean {
  return mode === "running" || mode === "permission" || mode === "question" || mode === "waiting_plan_review" || mode === "plan_revision" || mode === "confirm_interrupt";
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
  choiceIndex: number;
  permission?: TuiState["permissionRequests"][number];
  review?: TuiState["pendingReview"];
  selectWorkflow: (workflow: string) => void;
  resolvePermission: (requestId: string, decision: "allow_once" | "deny_once") => void;
  resolvePlan: (decision: "continue" | "stay") => void;
  resolveInterrupt: (decision: "interrupt" | "stay") => void;
}): InteractionChoice | undefined {
  if (input.mode === "select_workflow" && input.workflows.length) {
    const options = input.workflows.map((workflow, index) => ({ label: workflow, value: workflow, shortcut: String(index + 1) }));
    const selectedValue = options[Math.min(input.choiceIndex, options.length - 1)]?.value ?? options[0].value;
    return { title: "Select workflow", options, selectedValue, onSubmit: input.selectWorkflow };
  }
  if (input.mode === "permission" && input.permission) {
    const options = [
      { label: "Allow once", value: "allow_once", shortcut: "y" },
      { label: "Deny once", value: "deny_once", shortcut: "n" }
    ];
    const selectedValue = options[Math.min(input.choiceIndex, options.length - 1)].value;
    return {
      title: "Permission required",
      detail: `${input.permission.tool} ${input.permission.specifier}`,
      options,
      selectedValue,
      onSubmit: (value) => input.resolvePermission(input.permission?.requestId ?? "", value === "deny_once" ? "deny_once" : "allow_once")
    };
  }
  if (input.mode === "waiting_plan_review" && input.review) {
    const options = [
      { label: "Yes, continue execution by plan", value: "continue", shortcut: "y" },
      { label: "No, staying in the plan", value: "stay", shortcut: "n" }
    ];
    const selectedValue = options[Math.min(input.choiceIndex, options.length - 1)].value;
    return { title: "Plan decision", options, selectedValue, onSubmit: (value) => input.resolvePlan(value === "stay" ? "stay" : "continue") };
  }
  if (input.mode === "confirm_interrupt") {
    const options = [
      { label: "Interrupt run", value: "interrupt", shortcut: "y" },
      { label: "Keep running", value: "stay", shortcut: "n" }
    ];
    const selectedValue = options[Math.min(input.choiceIndex, options.length - 1)].value;
    return { title: "Stop current run?", options, selectedValue, onSubmit: (value) => input.resolveInterrupt(value === "interrupt" ? "interrupt" : "stay") };
  }
  return undefined;
}

function layoutMetrics(input: { terminalRows: number; choice?: InteractionChoice }): { mainHeight: number } {
  const headerRows = 3;
  const flowRows = 4;
  const promptRows = 4;
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
