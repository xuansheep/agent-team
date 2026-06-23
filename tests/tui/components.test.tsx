import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
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
import { resolveCtrlCBehavior, TuiApp } from "../../src/tui/TuiApp.js";

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

  it("renders workflow nodes as larger blocks with status below each node", () => {
    const output = render(
      <WorkflowFlowChart
        workflowNodes={[{ id: "product", role: "product" }, { id: "dev", role: "developer" }, { id: "test", role: "tester" }]}
        nodes={[{ nodeId: "dev", attempt: 1, status: "running" }, { nodeId: "product", attempt: 1, status: "success" }]}
        currentNodeId="dev"
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /product/);
    assert.match(frame, /已完成 #1/);
    assert.match(frame, /dev/);
    assert.match(frame, /运行中 #1/);
    assert.match(frame, /test/);
    assert.match(frame, /等待中/);
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
  it("renders compact logs without detailed tool payloads", () => {
    const output = render(
      <RunLogPanel
        detailMode={false}
        currentNodeId="dev"
        currentAttempt={1}
        items={[
          { kind: "user", text: "实现功能" },
          { kind: "status", nodeId: "dev", attempt: 1, text: "正在执行 Bash...", detailText: "命令：npm test" },
          { kind: "status", nodeId: "dev", attempt: 1, text: "dev 已完成：实现完成", detailText: "摘要：实现完成" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Logs compact/);
    assert.match(frame, /Ctrl\+O details/);
    assert.match(frame, /User/);
    assert.match(frame, /实现功能/);
    assert.match(frame, /正在执行 Bash/);
    assert.doesNotMatch(frame, /npm test/);
    output.unmount();
    output.cleanup();
  });

  it("renders detailed logs with tool payload details", () => {
    const output = render(
      <RunLogPanel
        detailMode={true}
        currentNodeId="dev"
        currentAttempt={1}
        items={[
          { kind: "status", nodeId: "dev", attempt: 1, text: "Bash 执行完成", detailText: "输出：ok" },
          { kind: "status", nodeId: "test", attempt: 1, text: "hidden other node", detailText: "hidden detail" }
        ]}
      />
    );

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Logs detailed/);
    assert.match(frame, /Ctrl\+O compact/);
    assert.match(frame, /Bash 执行完成/);
    assert.match(frame, /输出/);
    assert.doesNotMatch(frame, /hidden other node/);
    output.unmount();
    output.cleanup();
  });
});



describe("InteractionArea", () => {
  it("keeps choices and prompt together in the bottom interaction area", () => {
    const output = render(
      <InteractionArea
        promptTop={20}
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
      providers: {},
      roles: {},
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
    assert.match(frame, /等待中/);
    assert.match(frame, /Logs compact/);
    assert.ok(frame.indexOf("product") < frame.indexOf("Type a request or /help"));
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
