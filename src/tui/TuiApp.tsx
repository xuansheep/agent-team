import React, { useState } from "react";
import { Box, Text } from "ink";
import { initialTuiState } from "./eventAdapter.js";
import { Footer } from "./components/Footer.js";
import { Header } from "./components/Header.js";
import { NodeStatusList } from "./components/NodeStatusList.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { PromptInput } from "./components/PromptInput/PromptInput.js";
import { ResultPanel } from "./components/ResultPanel.js";
import { RunTimeline } from "./components/RunTimeline.js";
import { ToolCallList } from "./components/ToolCallList.js";
import { UserQuestionPrompt } from "./components/UserQuestionPrompt.js";

export function TuiApp({ cwd, initialError }: { cwd: string; initialError?: string }) {
  const [state] = useState(initialTuiState({ cwd }));
  const [queued] = useState<string[]>([]);

  if (initialError) {
    return (
      <Box flexDirection="column">
        <Header cwd={cwd} />
        <Text color="red">{initialError}</Text>
        <Text>Run agent-team init to create agent-team.yaml</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Header cwd={cwd} workflowId={state.workflowId} runId={state.runId} />
      <NodeStatusList nodes={state.nodes} />
      <ToolCallList tools={state.tools} />
      <PermissionPrompt request={state.permissionRequests[0]} onResolve={() => undefined} />
      <UserQuestionPrompt questions={state.questions} />
      <RunTimeline items={state.timeline} />
      <ResultPanel mode={state.mode} error={state.error} runId={state.runId} />
      <PromptInput mode="input" workflowId={state.workflowId} queued={queued} workflows={[]} isLoading={false} onEvent={() => undefined} />
      <Footer mode={state.mode} />
    </Box>
  );
}
