import React, { useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { AgentTeamConfig } from "../config/schema.js";
import { WorkflowEngine } from "../workflow/engine.js";
import { WorkflowSession } from "../workflow/session.js";
import { initialTuiState, reduceStoredEvent } from "./eventAdapter.js";
import { TuiState } from "./state.js";
import { Footer } from "./components/Footer.js";
import { Header } from "./components/Header.js";
import { NodeStatusList } from "./components/NodeStatusList.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { PromptInputEvent, PromptInputMode } from "./components/PromptInput/types.js";
import { PromptInput } from "./components/PromptInput/PromptInput.js";
import { ResultPanel } from "./components/ResultPanel.js";
import { RunTimeline } from "./components/RunTimeline.js";
import { ToolCallList } from "./components/ToolCallList.js";
import { UserQuestionPrompt } from "./components/UserQuestionPrompt.js";
import { WorkflowPicker } from "./components/WorkflowPicker.js";

export function TuiApp({
  cwd,
  initialError,
  config,
  workflows = [],
  workflowId,
  engine
}: {
  cwd: string;
  initialError?: string;
  config?: AgentTeamConfig;
  workflows?: string[];
  workflowId?: string;
  engine?: WorkflowEngine;
}) {
  const [selectedWorkflowId, setSelectedWorkflowId] = useState(workflowId);
  const [state, setState] = useState<TuiState>(() => ({
    ...initialTuiState({ cwd }),
    mode: workflowId ? "input" as const : workflows.length > 1 ? "select_workflow" as const : "input" as const,
    workflowId
  }));
  const [queued, setQueued] = useState<string[]>([]);
  const sessionRef = useRef<WorkflowSession>();

  useInput((input, key) => {
    if (!sessionRef.current || input !== "c" || !key.ctrl) return;
    if (state.mode !== "confirm_interrupt") {
      setState((current) => ({ ...current, mode: "confirm_interrupt" }));
      return;
    }
    void sessionRef.current.interrupt();
  });

  if (initialError) {
    return (
      <Box flexDirection="column">
        <Header cwd={cwd} />
        <Text color="red">{initialError}</Text>
        <Text>Run agent-team init to create agent-team.yaml</Text>
      </Box>
    );
  }

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
      setState((current) => ({ ...current, runId: session.runId, workflowId: selectedWorkflowId, mode: "running" }));
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
    if (state.mode === "question") {
      void sessionRef.current?.resumeWithUserInput({ answer: event.text }).catch((error) => failUi(error));
      return;
    }
    void startRun(event.text);
  };

  const promptMode: PromptInputMode =
    state.mode === "running" || state.mode === "permission" || state.mode === "question" || state.mode === "confirm_interrupt"
      ? state.mode
      : "input";
  const isLoading = state.mode === "running" || state.mode === "permission";

  if (!selectedWorkflowId && workflows.length > 0) {
    return (
      <Box flexDirection="column">
        <Header cwd={cwd} workflowId={state.workflowId} runId={state.runId} />
        <WorkflowPicker workflows={workflows} selected={selectedWorkflowId} onSelect={selectWorkflow} />
        <Footer mode={state.mode} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header cwd={cwd} workflowId={state.workflowId} runId={state.runId} />
      <NodeStatusList nodes={state.nodes} />
      <ToolCallList tools={state.tools} />
      <PermissionPrompt
        request={state.permissionRequests[0]}
        onResolve={(requestId, decision) => {
          try {
            sessionRef.current?.permissions.resolve(requestId, decision);
          } catch (error) {
            failUi(error);
          }
        }}
      />
      <UserQuestionPrompt questions={state.questions} />
      <RunTimeline items={state.timeline} />
      <ResultPanel mode={state.mode} error={state.error} runId={state.runId} />
      <PromptInput mode={promptMode} workflowId={state.workflowId} queued={queued} workflows={workflows} isLoading={isLoading} onEvent={handlePromptEvent} />
      <Footer mode={state.mode} />
    </Box>
  );
}
