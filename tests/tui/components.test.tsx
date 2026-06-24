import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { createRef } from "react";
import { Box, ScrollBox, Text } from "../../src/tui/ink.js";
import type { ScrollBoxHandle } from "../../src/tui/ink.js";
import { PromptInput } from "../../src/tui/components/PromptInput/PromptInput.js";
import { ModelStreamPanel } from "../../src/tui/components/ModelStreamPanel.js";
import { NodeStatusList } from "../../src/tui/components/NodeStatusList.js";
import { RunConversationPanel } from "../../src/tui/components/RunConversationPanel.js";
import { RunLogPanel } from "../../src/tui/components/RunLogPanel.js";
import { WorkflowFlowChart } from "../../src/tui/components/WorkflowFlowChart.js";
import { ChoicePrompt } from "../../src/tui/components/ChoicePrompt.js";
import { PermissionPrompt } from "../../src/tui/components/PermissionPrompt.js";
import { PlanReviewPrompt } from "../../src/tui/components/PlanReviewPrompt.js";
import { InteractionArea } from "../../src/tui/components/InteractionArea.js";
import { jumpMainScrollBy, resolveCtrlCBehavior, scrollMainDown, scrollMainUp, TuiApp } from "../../src/tui/TuiApp.js";

describe("PromptInput component", () => {
  it("renders mode and footer status", () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    assert.match(output.lastFrame() ?? "", /INPUT/);
    assert.match(output.lastFrame() ?? "", /delivery/);
    output.unmount();
    output.cleanup();
  });

  it("renders an empty shell prompt with placeholder text", () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, />/);
    assert.match(frame, /Type a request or \/help/);
    output.unmount();
    output.cleanup();
  });

  it("renders selectable slash command completions and applies them with Tab", async () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery", "audit"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    output.stdin.write("/r");
    await settleInkInput();
    assert.match(output.lastFrame() ?? "", /> \/run/);
    assert.match(output.lastFrame() ?? "", /Run a workflow/);

    output.stdin.write("\t");
    await settleInkInput();
    assert.match(output.lastFrame() ?? "", /\/run /);
    assert.match(output.lastFrame() ?? "", /<workflow>/);
    output.unmount();
    output.cleanup();
  });

  it("closes slash command completions with Escape", async () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    output.stdin.write("/r");
    await settleInkInput();
    assert.match(output.lastFrame() ?? "", /Run a workflow/);
    output.stdin.write("\u001b");
    await settleTerminalEscape();
    assert.doesNotMatch(output.lastFrame() ?? "", /Run a workflow/);
    assert.match(output.lastFrame() ?? "", /\/r/);
    output.unmount();
    output.cleanup();
  });

  it("keeps mouse reporting out of the prompt buffer", async () => {
    const output = render(
      <PromptInput
        mode="input"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={false}
        onEvent={() => undefined}
      />
    );

    output.stdin.write("\u001b[<64;12;5M");
    await settleInkInput();
    const frame = output.lastFrame() ?? "";
    assert.doesNotMatch(frame, /64;12;5/);
    assert.match(frame, /Type a request or \/help/);
    output.unmount();
    output.cleanup();
  });

  it("renders recent streaming model output", () => {
    const output = render(<ModelStreamPanel streams={[{ nodeId: "product", attempt: 1, text: "生成中的 JSON 内容" }]} />);

    assert.match(output.lastFrame() ?? "", /product #1 streaming/);
    assert.match(output.lastFrame() ?? "", /生成中的 JSON 内容/);
    output.unmount();
    output.cleanup();
  });

  it("resolves Ctrl+C to exit outside active workflow sessions", () => {
    assert.equal(resolveCtrlCBehavior("input", false), "exit");
    assert.equal(resolveCtrlCBehavior("completed", true), "exit");
    assert.equal(resolveCtrlCBehavior("running", true), "confirm_interrupt");
    assert.equal(resolveCtrlCBehavior("confirm_interrupt", true), "interrupt");
  });
});

describe("Workflow node status component", () => {
  it("renders every configured workflow node with pending state before it runs", () => {
    const output = render(
      <NodeStatusList
        workflowNodes={[{ id: "product", role: "product" }, { id: "dev", role: "developer" }, { id: "test", role: "tester" }]}
        nodes={[{ nodeId: "product", attempt: 1, status: "running" }]}
        currentNodeId="product"
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /product #1 running/);
    assert.match(frame, /dev pending/);
    assert.match(frame, /test pending/);
    output.unmount();
    output.cleanup();
  });

  it("renders workflow nodes with model names, English statuses, and an active running border", () => {
    const output = render(
      <WorkflowFlowChart
        workflowNodes={[{ id: "product", role: "product", model: "gpt5.5" }, { id: "dev", role: "developer", model: "claude-dev" }, { id: "test", role: "tester" }]}
        nodes={[{ nodeId: "dev", attempt: 1, status: "running" }, { nodeId: "product", attempt: 1, status: "success" }]}
        currentNodeId="dev"
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /product/);
    assert.match(frame, /model: gpt5\.5/);
    assert.match(frame, /done #1/);
    assert.match(frame, /dev/);
    assert.match(frame, /model: claude-dev/);
    assert.match(frame, /running #1/);
    assert.match(frame, /◝/);
    assert.doesNotMatch(frame, /[◜◞◟]/);
    assert.match(frame, /test/);
    assert.match(frame, /pending/);
    assert.doesNotMatch(frame, /已完成|运行中|等待中/);
    assert.doesNotMatch(frame, /product #1 success/);
    output.unmount();
    output.cleanup();
  });
});



describe("ChoicePrompt", () => {
  it("defaults to the configured option and submits it with Enter", async () => {
    const submitted: string[] = [];
    const output = render(
      <ChoicePrompt
        title="Permission required"
        detail="LS ."
        defaultValue="allow_once"
        options={[
          { label: "Allow once", value: "allow_once", shortcut: "y" },
          { label: "Deny once", value: "deny_once", shortcut: "n" }
        ]}
        onSubmit={(value) => submitted.push(value)}
      />
    );

    assert.match(output.lastFrame() ?? "", /> Allow once/);
    output.stdin.write("\r");
    await settleInkInput();
    assert.deepEqual(submitted, ["allow_once"]);
    output.unmount();
    output.cleanup();
  });

  it("moves selection with arrow keys and submits with Enter", async () => {
    const submitted: string[] = [];
    const output = render(
      <ChoicePrompt
        title="Permission required"
        detail="LS ."
        defaultValue="allow_once"
        options={[
          { label: "Allow once", value: "allow_once", shortcut: "y" },
          { label: "Deny once", value: "deny_once", shortcut: "n" }
        ]}
        onSubmit={(value) => submitted.push(value)}
      />
    );

    await settleInkInput();
    output.stdin.write("\u001b[B");
    await settleInkInput();
    assert.match(output.lastFrame() ?? "", /> Deny once/);
    output.stdin.write("\r");
    await settleInkInput();
    assert.deepEqual(submitted, ["deny_once"]);
    output.unmount();
    output.cleanup();
  });

  it("submits matching shortcut keys", async () => {
    const submitted: string[] = [];
    const output = render(
      <ChoicePrompt
        title="Permission required"
        defaultValue="allow_once"
        options={[
          { label: "Allow once", value: "allow_once", shortcut: "y" },
          { label: "Deny once", value: "deny_once", shortcut: "n" }
        ]}
        onSubmit={(value) => submitted.push(value)}
      />
    );

    output.stdin.write("n");
    await settleInkInput();
    assert.deepEqual(submitted, ["deny_once"]);
    output.unmount();
    output.cleanup();
  });
});




  it("renders controlled selection without owning keyboard focus", () => {
    const output = render(
      <ChoicePrompt
        title="Permission required"
        defaultValue="allow_once"
        selectedValue="deny_once"
        options={[
          { label: "Allow once", value: "allow_once", shortcut: "y" },
          { label: "Deny once", value: "deny_once", shortcut: "n" }
        ]}
        interactive={false}
        onSubmit={() => undefined}
      />
    );

    assert.match(output.lastFrame() ?? "", /> Deny once/);
    output.unmount();
    output.cleanup();
  });

describe("PlanReviewPrompt", () => {
  it("renders up to 15 visible plan lines", () => {
    const document = Array.from({ length: 18 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join("\n");
    const output = render(<PlanReviewPrompt review={{ type: "plan", nodeId: "product", attempt: 1, document }} visibleRows={15} />);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /line-15/);
    assert.doesNotMatch(frame, /line-16/);
    output.unmount();
    output.cleanup();
  });

  it("renders a scrollable plan review window without inline decisions", () => {
    const document = Array.from({ length: 18 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`).join("\n");
    const output = render(
      <PlanReviewPrompt
        review={{ type: "plan", nodeId: "product", attempt: 1, document }}
        offset={1}
        visibleRows={6}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Plan Review/);
    assert.match(frame, /line-02/);
    assert.doesNotMatch(frame, /Yes, continue execution by plan/);
    assert.doesNotMatch(frame, /> No, staying in the plan/);
    output.unmount();
    output.cleanup();
  });
});

describe("PermissionPrompt", () => {
  it("uses the reusable choice prompt and defaults to allow once", async () => {
    const submitted: Array<[string, "allow_once" | "deny_once"]> = [];
    const output = render(
      <PermissionPrompt
        request={{
          requestId: "perm-1",
          nodeId: "product",
          attempt: 1,
          toolCallId: "tool-1",
          tool: "LS",
          input: { path: "." },
          specifier: "."
        }}
        onResolve={(requestId, decision) => submitted.push([requestId, decision])}
      />
    );

    assert.match(output.lastFrame() ?? "", /Permission required/);
    assert.match(output.lastFrame() ?? "", /LS ./);
    assert.match(output.lastFrame() ?? "", /> Allow once/);
    output.stdin.write("\r");
    await settleInkInput();
    assert.deepEqual(submitted, [["perm-1", "allow_once"]]);
    output.unmount();
    output.cleanup();
  });
});


describe("RunConversationPanel", () => {
  it("renders user messages, current node output, and current node status", () => {
    const output = render(
      <RunConversationPanel
        currentNodeId="product"
        currentAttempt={1}
        items={[
          { kind: "user", text: "请实现 TUI" },
          { kind: "assistant", nodeId: "product", attempt: 1, text: "{\"status\":\"success\"}" },
          { kind: "status", nodeId: "product", attempt: 1, text: "product #1 running" },
          { kind: "assistant", nodeId: "dev", attempt: 1, text: "dev output should be hidden" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /user/);
    assert.match(frame, /请实现 TUI/);
    assert.match(frame, /product #1 running/);
    assert.match(frame, /\{\"status\":\"success\"\}/);
    assert.doesNotMatch(frame, /dev output should be hidden/);
    output.unmount();
    output.cleanup();
  });
});

describe("RunLogPanel", () => {
  it("renders compact logs with tui-code style tool rows", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        currentNodeId="dev"
        currentAttempt={1}
        items={[
          { id: "user-1", kind: "user", text: "实现功能" },
          {
            id: "tool-1",
            kind: "tool",
            nodeId: "dev",
            attempt: 1,
            toolCallId: "tool-1",
            tool: "Bash",
            status: "running",
            text: "Bash",
            summary: "npm test",
            detailText: "命令：npm test"
          },
          { id: "status-1", kind: "status", nodeId: "dev", attempt: 1, text: "dev 已完成：实现完成", detailText: "摘要：实现完成" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /ctrl\+o to expand/i);
    assert.match(frame, /实现功能/);
    assert.match(frame, /●\s+Bash\s+\(npm test\)/);
    assert.match(frame, /dev 已完成：实现完成/);
    assert.doesNotMatch(frame, /命令：npm test/);
    output.unmount();
    output.cleanup();
  });

  it("renders detailed logs with message response indentation", () => {
    const output = render(
      <RunLogPanel
        detailMode={true}
        currentNodeId="dev"
        currentAttempt={1}
        items={[
          {
            id: "tool-1",
            kind: "tool",
            nodeId: "dev",
            attempt: 1,
            toolCallId: "tool-1",
            tool: "Bash",
            status: "completed",
            text: "Bash",
            summary: "npm test",
            detailText: "输出：ok"
          },
          { id: "status-1", kind: "status", nodeId: "test", attempt: 1, text: "hidden other node", detailText: "hidden detail" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /ctrl\+o to collapse/i);
    assert.match(frame, /●\s+Bash\s+\(npm test\)/);
    assert.match(frame, /⎿/);
    assert.match(frame, /输出/);
    assert.doesNotMatch(frame, /hidden other node/);
    output.unmount();
    output.cleanup();
  });

  it("renders failed tool rows with error details only when expanded", () => {
    const output = render(
      <RunLogPanel
        detailMode={true}
        currentNodeId="dev"
        currentAttempt={1}
        items={[
          {
            id: "tool-1",
            kind: "tool",
            nodeId: "dev",
            attempt: 1,
            toolCallId: "tool-1",
            tool: "PowerShell",
            status: "failed",
            text: "PowerShell",
            summary: "node dist/cli/main.js",
            detailText: "错误：getCurrentEventPriority is not a function"
          }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /●\s+PowerShell\s+\(node dist\/cli\/main\.js\)/);
    assert.match(frame, /getCurrentEventPriority is not a function/);
    output.unmount();
    output.cleanup();
  });
});



describe("InteractionArea", () => {
  it("separates logs from the prompt and aligns prompt with log content", () => {
    const output = render(
      <Box flexDirection="column">
        <RunLogPanel
          detailMode={false}
          currentNodeId="dev"
          currentAttempt={1}
          items={[{ id: "user-1", kind: "user", text: "实现功能" }]}
        />
        <InteractionArea
          mode="input"
          workflowId="delivery"
          queued={[]}
          workflows={["delivery"]}
          isLoading={false}
          onPromptEvent={() => undefined}
        />
      </Box>
    );

    const lines = (output.lastFrame() ?? "").split("\n");
    const logHeaderIndex = lines.findIndex((line) => line.includes("Logs compact"));
    const promptIndex = lines.findIndex((line) => line.includes("Type a request or /help"));

    assert.notEqual(logHeaderIndex, -1);
    assert.notEqual(promptIndex, -1);
    assert.equal(lines[promptIndex - 1], "");
    assert.ok(lines[logHeaderIndex].startsWith("Logs compact"));
    assert.ok(lines[promptIndex].startsWith("INPUT"));
    output.unmount();
    output.cleanup();
  });

  it("keeps choices and prompt together in the bottom interaction area", () => {
    const output = render(
      <InteractionArea
        mode="permission"
        workflowId="delivery"
        queued={[]}
        workflows={["delivery"]}
        isLoading={true}
        onPromptEvent={() => undefined}
        choice={{
          title: "Permission required",
          detail: "LS .",
          selectedValue: "allow_once",
          options: [
            { label: "Allow once", value: "allow_once", shortcut: "y" },
            { label: "Deny once", value: "deny_once", shortcut: "n" }
          ],
          onSubmit: () => undefined
        }}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Permission required/);
    assert.match(frame, /> Allow once/);
    assert.match(frame, /PERMISSION/);
    assert.match(frame, /Type a request or \/help/);
    output.unmount();
    output.cleanup();
  });
});

describe("TuiApp", () => {
  it("renders missing config guidance", () => {
    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" initialError="Missing agent-team.yaml" />);

    assert.match(output.lastFrame() ?? "", /Missing agent-team.yaml/);
    assert.match(output.lastFrame() ?? "", /agent-team init/);
    output.unmount();
    output.cleanup();
  });

  it("keeps the prompt as the bottom interaction area in the running layout", () => {
    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" workflows={["delivery"]} workflowId="delivery" />);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /agent-team/);
    assert.match(frame, />/);
    assert.doesNotMatch(frame, /mode input \| Ctrl\+C stop/);
    assert.ok(frame.indexOf("Type a request or /help") > frame.indexOf("workflow delivery"));
    output.unmount();
    output.cleanup();
  });

  it("pins configured workflow nodes above the prompt", () => {
    const config = {
      providers: {
        default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } }
      },
      roles: {
        product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } },
        developer: { description: "", system_prompt: "developer", default_model: "gpt5.5", requires: { tool_calling: false, vision: false } }
      },
      workflows: {
        delivery: {
          nodes: [
            { id: "product", role: "product", provider: "default", permission_mode: "default" as const },
            { id: "dev", role: "developer", provider: "default", permission_mode: "default" as const }
          ],
          edges: []
        }
      }
    };
    const output = render(<TuiApp cwd="D:\\CodeAI\\agent-team" config={config} workflows={["delivery"]} workflowId="delivery" />);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /product/);
    assert.match(frame, /dev/);
    assert.match(frame, /pending/);
    assert.match(frame, /model: gpt-test/);
    assert.match(frame, /model: gpt5\.5/);
    assert.match(frame, /Logs compact/);
    assert.ok(frame.indexOf("product") < frame.indexOf("Type a request or /help"));
    output.unmount();
    output.cleanup();
  });
});

describe("main scroll helpers", () => {
  it("jumps by half pages from the effective pending scroll position", () => {
    const handle = createScrollHandle({ top: 8, pending: 2, height: 20, viewport: 4 });

    assert.equal(jumpMainScrollBy(handle, -3), false);

    assert.deepEqual(handle.calls, [["scrollTo", 7]]);
  });

  it("restores sticky scroll when page jumps reach the bottom", () => {
    const handle = createScrollHandle({ top: 7, pending: 1, height: 12, viewport: 4 });

    assert.equal(jumpMainScrollBy(handle, 3), true);

    assert.deepEqual(handle.calls, [["scrollTo", 8], ["scrollToBottom"]]);
  });

  it("clears pending wheel movement when scrolling above the top", () => {
    const handle = createScrollHandle({ top: 1, pending: -1, height: 12, viewport: 4 });

    scrollMainUp(handle, 3);

    assert.deepEqual(handle.calls, [["scrollTo", 0]]);
  });

  it("restores sticky scroll when wheeling down reaches the bottom", () => {
    const handle = createScrollHandle({ top: 6, pending: 1, height: 10, viewport: 3 });

    assert.equal(scrollMainDown(handle, 2), true);

    assert.deepEqual(handle.calls, [["scrollToBottom"]]);
  });

  it("attaches the ScrollBox imperative handle through React refs", async () => {
    const ref = createRef<ScrollBoxHandle>();
    const output = render(
      <ScrollBox ref={ref} height={3} flexDirection="column">
        <Text>line</Text>
      </ScrollBox>
    );

    await settleInkInput();
    assert.equal(typeof (ref.current as { scrollBy?: unknown } | null)?.scrollBy, "function");
    output.unmount();
    output.cleanup();
  });
});

function settleInkInput(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function settleTerminalEscape(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 35));
}

function createScrollHandle(input: { top: number; pending: number; height: number; viewport: number }) {
  const calls: Array<["scrollTo", number] | ["scrollBy", number] | ["scrollToBottom"]> = [];
  return {
    calls,
    scrollTo: (value: number) => calls.push(["scrollTo", value]),
    scrollBy: (value: number) => calls.push(["scrollBy", value]),
    scrollToBottom: () => calls.push(["scrollToBottom"]),
    getScrollTop: () => input.top,
    getPendingDelta: () => input.pending,
    getScrollHeight: () => input.height,
    getViewportHeight: () => input.viewport
  };
}
