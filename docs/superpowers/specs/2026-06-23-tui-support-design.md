# TUI Support Design

## Goal

Add a production-grade terminal UI to `agent-team` while preserving the current script-friendly CLI commands.

The default command `agent-team` starts an interactive TUI. Existing subcommands remain headless:

- `agent-team run ...`
- `agent-team resume ...`
- `agent-team status ...`
- `agent-team inspect ...`
- `agent-team init`

The design follows the architecture shape of `D:\CodeAI\claude-code`: dynamic interactive entry, React terminal components, a separated prompt input subsystem, event-driven rendering, and runtime/UI separation. It does not copy source code from that reference project.

## Non-Goals

- No model token-level streaming in the first TUI version.
- No multi-session manager.
- No remote session, tmux, IDE bridge, or background session control.
- No image paste support.
- No full Vim mode implementation.
- No external editor integration.
- No copying implementation code from `D:\CodeAI\claude-code`.

## Architecture

The implementation uses a three-layer design.

`src/workflow` remains the workflow semantic layer. It owns node ordering, success and failure transitions, `waiting_user`, `resume`, and `interrupted` state. It must not import React or Ink.

`src/harness` becomes an event-driven runtime layer. It owns provider calls, tool execution, permission decisions, event persistence, and runtime continuation. It exposes a headless API for existing commands and an interactive session API for the TUI.

`src/tui` is the interactive presentation layer. It loads default config, collects user input, starts workflow sessions, subscribes to events, renders state, resolves permission prompts, answers user questions, and handles interrupt confirmation. It must not execute tools directly.

## CLI Entry Rules

No subcommand means interactive mode:

```text
agent-team
```

Subcommands keep current behavior:

```text
agent-team run -f agent-team.yaml --workflow delivery --input "..."
agent-team resume <run_id> -f agent-team.yaml --workflow delivery --answer "..."
agent-team status <run_id>
agent-team inspect <run_id>
agent-team init
```

This preserves automation compatibility. TUI output must not pollute stdout for headless commands.

## TUI Startup Flow

On startup, the TUI reads `agent-team.yaml` in the current directory.

If the file is missing, the TUI shows a recoverable error with guidance to run `agent-team init`. It does not create the file implicitly.

If workflow `delivery` exists, the TUI selects it by default. If `delivery` does not exist and multiple workflows exist, the TUI opens a workflow picker. If exactly one workflow exists, it selects that workflow.

The user enters one workflow request. The first version runs one workflow per TUI session, then stays on the result screen or exits by user action.

## Interactive Runtime API

`WorkflowEngine.run(...)` stays available for headless commands.

The TUI uses a new interactive API:

```ts
type WorkflowSession = {
  runId: string;
  state: WorkflowState;
  events: AsyncIterable<StoredEvent>;
  permissions: PermissionController;
  interrupt(): Promise<void>;
  resumeWithUserInput(input: unknown): Promise<void>;
  result: Promise<WorkflowState>;
};
```

The implementation should use this shape unless TypeScript integration exposes a concrete incompatibility. If names change during implementation, the same capabilities and lifecycle semantics must remain:

- expose the run id early;
- stream stored events to the UI;
- pause on permission requests;
- resume from user answers;
- interrupt safely;
- resolve final state.

## Permission Flow

Current `ask` permission behavior fails immediately. TUI support changes this for interactive sessions.

Runtime permission decisions:

- `deny`: append `tool_failed`, then fail the tool or node according to existing runtime policy.
- `allow`: execute the tool immediately.
- `ask`: append `permission_requested`, pause the tool call, wait for a TUI decision, then append `permission_resolved`.

The first TUI version supports:

- allow once;
- deny once.

Persistent permission edits are out of scope.

If the user denies a permission request, runtime records the denial. The tool result returned to the model should clearly describe that the user denied permission unless the runtime is in a policy mode that treats denial as node failure.

## Event Model

Existing events remain valid. Add these events:

```ts
type InteractiveHarnessEvent =
  | {
      type: "permission_requested";
      request_id: string;
      node_id: string;
      attempt: number;
      tool_call_id: string;
      tool: string;
      input: unknown;
      rule?: string;
      specifier: string;
    }
  | {
      type: "permission_resolved";
      request_id: string;
      node_id: string;
      attempt: number;
      tool_call_id: string;
      decision: "allow_once" | "deny_once";
    }
  | {
      type: "node_interrupted";
      node_id: string;
      attempt: number;
    }
  | {
      type: "run_interrupted";
      reason: "user";
    };
```

Enhance tool events with stable correlation fields:

```ts
{
  node_id: string;
  attempt: number;
  tool_call_id: string;
}
```

These fields let the TUI group tool activity under the correct node attempt.

## TUI State

The TUI uses a reducer fed by `StoredEvent`.

The reducer tracks:

- selected config file;
- selected workflow;
- run id;
- run status;
- current node;
- node attempts;
- tool calls;
- permission request queue;
- user question state;
- prompt input state;
- interrupt confirmation state;
- final result or error.

UI state is derived from events and explicit user input. It should not parse `.runs` files directly during an active run.

## Component Structure

Add:

```text
src/tui/
  launchTui.tsx
  TuiApp.tsx
  state.ts
  eventAdapter.ts
  components/
    Header.tsx
    WorkflowPicker.tsx
    RunTimeline.tsx
    NodeStatusList.tsx
    ToolCallList.tsx
    PermissionPrompt.tsx
    UserQuestionPrompt.tsx
    ResultPanel.tsx
    Footer.tsx
    PromptInput/
      PromptInput.tsx
      PromptInputFooter.tsx
      PromptInputModeIndicator.tsx
      PromptInputQueuedCommands.tsx
      PromptInputSuggestions.tsx
      PromptInputHistory.tsx
      PromptInputStashNotice.tsx
      usePromptBuffer.ts
      usePromptHistory.ts
      usePromptKeybindings.ts
      usePromptSuggestions.ts
      keybindings.ts
      types.ts
```

The top-level components have these responsibilities:

- `TuiApp`: session state machine and coordination.
- `Header`: product, cwd, config, workflow, and run id.
- `WorkflowPicker`: workflow selection when defaults are insufficient.
- `RunTimeline`: high-level event timeline.
- `NodeStatusList`: node and attempt status.
- `ToolCallList`: expandable tool input and output summaries.
- `PermissionPrompt`: allow once or deny once.
- `UserQuestionPrompt`: answer `needs_user_input` questions.
- `ResultPanel`: final state, error, and run id.
- `Footer`: key hints and current mode.

Components consume UI state and callbacks. They do not call providers, tools, or storage directly.

## PromptInput Design

`PromptInput` is a production-grade subsystem, not a simple text field.

It should match Claude Code's architecture and behavior as closely as practical while staying a clean-room implementation.

Required first-version capabilities:

- fixed bottom input region;
- multiline prompt buffer;
- cursor movement;
- internal selection state for future expansion, with first-version rendering allowed to show only the cursor if terminal selection support is not stable;
- submit with Enter;
- newline with `Alt+Enter`, plus `Ctrl+J` as a fallback when terminal input exposes it distinctly;
- clear or cancel;
- input history navigation;
- slash command framework;
- queued input while a workflow is running;
- stash notice for unsent input;
- footer status;
- mode indicator;
- suggestion framework for slash commands and workflow names;
- independent keybinding module;
- logic split into hooks and reducers so it can be tested without terminal rendering.

Initial slash command framework includes:

- `/run`
- `/resume`
- `/status`
- `/help`

The first version may route only `/run` into the workflow start path and show help/status information for the other commands. The framework must make later command expansion straightforward.

PromptInput events passed to `TuiApp` are structured:

```ts
type PromptInputEvent =
  | { type: "submit"; text: string }
  | { type: "cancel" }
  | { type: "command"; name: string; args: string[] }
  | { type: "queue"; text: string };
```

`TuiApp` decides what each event means in the current mode.

## Display Rules

Default display is concise:

- current workflow;
- run id;
- current node and attempt;
- node statuses;
- tool name and status;
- permission request summary;
- final summary.

Tool details are expandable. Expanded details show truncated JSON input and output. The UI must avoid dumping large or sensitive content by default.

Provider raw requests and raw responses are not shown in TUI. They may remain available through explicit debug logs or future debug commands.

## Interrupt Flow

`Ctrl+C` is two-step.

First press enters stop-confirm mode. It does not interrupt the run.

The confirmation action calls `session.interrupt()`.

Interrupt handling must:

- append `node_interrupted` when a node is active;
- append `run_interrupted`;
- save `WorkflowState.status = "interrupted"`;
- retain `current_node_id`, `attempts`, and `handoff`;
- show the run id and recovery guidance.

Interrupted recovery is defined as starting a new attempt for the current node with the saved handoff and interrupt metadata. It is not a continuation of a half-finished provider request or tool process.

## Waiting User Flow

When a node returns `needs_user_input`, runtime saves `WorkflowState.status = "waiting_user"` and appends `node_waiting_user`.

TUI displays the required questions and collects an answer. It then calls `session.resumeWithUserInput(...)`.

Resume continues from the same node and creates a new attempt. The resumed handoff includes the previous handoff and user input.

## Error Handling

Recoverable UI errors stay in the TUI:

- missing config file;
- missing workflow;
- empty prompt;
- missing provider key before run start.

Runtime errors become run or node failures:

- provider failures;
- tool failures that cannot be returned to the model;
- invalid node JSON;
- missing model capability;
- storage failures.

The TUI displays the failed node, error summary, and run id. It must not hide the run id.

## Sensitive Output Handling

The TUI must avoid high-risk default output.

- Tool output is truncated by default.
- Expanded details are user initiated.
- Denied paths such as `.env` and `secrets/**` show the matched rule, not file contents.
- Provider raw request and response payloads are not displayed.
- Errors should be summarized without exposing secrets embedded in environment variables or authorization headers.

## Dependencies

Add:

- `react`
- `ink`

Optional helper packages may be used only if they reduce code and remain compatible with the existing ESM TypeScript setup. If text-input helper packages cannot support the required PromptInput behavior cleanly, implement the input buffer logic inside `src/tui/components/PromptInput`.

## Testing Strategy

Headless regression tests:

- `agent-team run ...` still emits JSON.
- `agent-team status ...` still reads state.
- `agent-team inspect ...` still reads events.
- no subcommand dispatches the TUI launcher.
- subcommands do not import or render Ink.

Runtime interaction tests:

- `ask` permission appends `permission_requested`.
- `allow_once` appends `permission_resolved` and executes the tool.
- `deny_once` appends `permission_resolved` and records denial.
- `interrupt()` writes `interrupted` state and events.
- `waiting_user` can resume from the same node.

TUI reducer and component tests:

- event reducer groups nodes, attempts, and tools correctly.
- `PromptInput` supports multiline buffer state.
- `PromptInput` supports history navigation.
- slash command parsing returns structured events.
- queued input is retained while running.
- permission prompt emits allow or deny decisions.
- first `Ctrl+C` enters confirmation mode.

Prefer deterministic reducer and hook tests over fragile terminal screenshot tests. Keep at least one Ink smoke test for startup rendering.

## Implementation Notes

Keep file boundaries small. Do not create a single large `REPL.tsx`.

Runtime code must not import TUI code. TUI code may import workflow and harness public APIs.

`PromptInput.tsx` should be primarily composition. Buffer editing, keybinding, history, and suggestions live in separate hooks or pure functions.

Do not weaken permission behavior for convenience. TUI permission confirmation is an interactive layer over the existing permission model, not a bypass.

Do not make hidden writes from TUI startup. Missing config guidance is safer than implicitly creating `agent-team.yaml`.

## Acceptance Criteria

- Running `agent-team` with no subcommand opens the TUI.
- Running existing subcommands keeps current headless behavior.
- A user can start one workflow from TUI and see live node and tool events.
- `ask` permissions are resolved inside TUI.
- `needs_user_input` is answered inside TUI.
- `Ctrl+C` requires confirmation and then writes `interrupted` state.
- Headless command tests still pass.
- Runtime interaction tests cover permission and interrupt paths.
- PromptInput logic is independently tested.
