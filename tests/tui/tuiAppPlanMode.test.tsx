import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { planRejectionMessage, TuiApp } from "../../src/tui/TuiApp.js";
import { getPlanFilePath, readPlan, writePlan } from "../../src/plans/planFiles.js";
import { planModeExitHandoffMarker, planModeExitPlanExistsMarker } from "../../src/plans/planSession.js";
import { SessionStore } from "../../src/storage/sessionStore.js";
import type { ModelProvider, ModelRequest } from "../../src/providers/types.js";
import { WorkflowEngine } from "../../src/workflow/engine.js";

const config = {
  providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
  roles: { product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } } },
  workflows: { delivery: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
};
const configWithContextWindow = {
  ...config,
  providers: { default: { ...config.providers.default, context_windows: { "gpt-test": 1000 } } }
};

describe("TuiApp global Plan Mode", () => {
  it("starts in Plan Mode when settings default to plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} settings={{ permissions: { defaultMode: "plan" } }} />);

    await waitForFrame(output, /Enabled plan mode/);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /PLAN > Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("shows the first message submitted while the input permission mode is plan", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} settings={{ permissions: { defaultMode: "plan" } }} />);

    await sendTuiLine(output, "Draft from the plan permission mode.");
    await waitForFrame(output, /Draft from the plan permission mode\./);
    await waitForRequest(requests, "Draft from the plan permission mode.");

    assert.equal(starts, 0);
    assert.doesNotMatch(output.lastFrame() ?? "", /Plan draft updated/);

    output.unmount();
    output.cleanup();
  });

  it("cycles permission modes with Shift+Tab and enters Plan Mode on the plan slot", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /mode accept edits/);
    assert.equal(starts, 0);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /Enabled plan mode/);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Shift\+Tab mode/);

    output.unmount();
    output.cleanup();
  });

  it("starts ordinary workflow turns with the selected Shift+Tab permission mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    output.stdin.write("\u001b[Z");
    await waitForFrame(output, /mode accept edits/);
    await sendTuiLine(output, "Start in accept edits.");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "acceptEdits" });

    output.unmount();
    output.cleanup();
  });

  it("prompts before entering Plan Mode from an EnterPlanMode workflow tool call", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-enter-plan-tool-");
    const planRequests: ModelRequest[] = [];
    let workflowTurns = 0;
    const workflowProvider: ModelProvider = {
      async generate(request) {
        if (request.context?.nodeId === "runtime") return planProvider(planRequests).generate(request);
        workflowTurns += 1;
        if (workflowTurns === 1) {
          return { content: "I should plan this first.", tool_calls: [{ id: "tool-enter-plan", name: "EnterPlanMode", input: {} }] };
        }
        return { content: JSON.stringify({ status: "success", summary: "abandoned", document: "", handoff: {}, deliverables: [] }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => workflowProvider, cwd, runRoot: join(cwd, ".session") });
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine} providerFactory={() => workflowProvider} />);

    await sendTuiLine(output, "Build auth flow with sign-off.");
    await waitForFrame(output, /Enter plan mode\?/);
    assert.match(output.lastFrame() ?? "", /· Explore the codebase thoroughly/);
    assert.match(output.lastFrame() ?? "", /No code changes will be made until you approve the plan\./);
    assert.match(output.lastFrame() ?? "", /Yes, enter plan mode/);
    assert.match(output.lastFrame() ?? "", /No, start implementing now/);

    output.stdin.write("\r");
    await waitForFrame(output, /Build auth flow with sign-off\./);
    await waitForRequest(planRequests, "Build auth flow with sign-off.");

    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("continues workflow implementation when EnterPlanMode is declined", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-enter-plan-decline-");
    const planRequests: ModelRequest[] = [];
    let workflowTurns = 0;
    const workflowProvider: ModelProvider = {
      async generate(request) {
        if (request.context?.nodeId === "runtime") return planProvider(planRequests).generate(request);
        workflowTurns += 1;
        if (workflowTurns === 1) {
          return { content: "I should plan this first.", tool_calls: [{ id: "tool-enter-plan", name: "EnterPlanMode", input: {} }] };
        }
        assert.match(requestText(request), /Permission denied by user for EnterPlanMode/);
        return { content: JSON.stringify({ status: "success", summary: "Implemented directly", document: "", handoff: {}, deliverables: [] }) };
      }
    };
    const engine = new WorkflowEngine({ providerFactory: () => workflowProvider, cwd, runRoot: join(cwd, ".session") });
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine} providerFactory={() => workflowProvider} />);

    await sendTuiLine(output, "Build auth flow without planning.");
    await waitForFrame(output, /Enter plan mode\?/);
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await waitForFrame(output, /Implemented directly/);

    assert.equal(workflowTurns, 2);
    assert.equal(planRequests.length, 0);
    assert.doesNotMatch(output.lastFrame() ?? "", /PLAN > Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("enters Plan Mode before workflow execution and does not start workflow while drafting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);
    assert.match(output.lastFrame() ?? "", /Draft the migration first\./);
    assert.doesNotMatch(output.lastFrame() ?? "", /Plan draft updated/);

    output.unmount();
    output.cleanup();
  });

  it("shows a Plan Mode user message while the planning turn is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={hangingPlanProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration while provider is pending.");
    await waitForFrame(output, /Draft the migration while provider is pending\./);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("shows queued Plan Mode user messages immediately while the previous turn is still running", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={hangingPlanProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "First planning message is still running.");
    await waitForFrame(output, /First planning message is still running\./);

    await sendTuiLine(output, "Second planning message should still be visible.");
    await waitForFrame(output, /Second planning message should still be visible\./);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("shows the Plan Mode Bash denial in the TUI without starting workflow execution", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const provider: ModelProvider = {
      async generate() {
        return { content: "Trying shell.", tool_calls: [{ id: "tool-bash-denied", name: "Bash", input: { command: "npm test", timeout_ms: 30000 } }] };
      }
    };
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={() => provider} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Try to run tests while planning.");
    await waitForFrame(output, /Permission denied for Bash: Plan Mode blocks shell execution/);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /PLAN > Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("runs /plan descriptions as the first planning turn", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan Draft from command arguments.");
    await waitForRequest(requests, "Draft from command arguments.");

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);

    output.unmount();
    output.cleanup();
  });

  it("treats /plan open outside Plan Mode as entering Plan Mode only", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    let opened = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editPlanFile={async () => {
        opened += 1;
        return { content: null };
      }}
    />);

    await sendTuiLine(output, "/plan open");
    await waitForFrame(output, /Enabled plan mode/);

    assert.equal(starts, 0);
    assert.equal(opened, 0);
    assert.equal(requests.length, 0);
    assert.match(output.lastFrame() ?? "", /PLAN > Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("does not open an editor for /plan open before any plan is written", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let opened = 0;
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      editPlanFile={async () => {
        opened += 1;
        return { content: null };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "/plan open");
    await waitForFrame(output, /Already in plan mode\. No plan written yet\./);

    assert.equal(opened, 0);
    assert.match(output.lastFrame() ?? "", /PLAN > Type a request or \/help/);

    output.unmount();
    output.cleanup();
  });

  it("opens the current Plan Mode plan with /plan open", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const editedFiles: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const previousEditor = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    process.env.EDITOR = "code";
    delete process.env.VISUAL;
    let output: ReturnType<typeof render> | undefined;
    try {
      output = render(<TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        engine={engine as never}
        providerFactory={planProviderFactory}
        editPlanFile={async (filePath) => {
          editedFiles.push(filePath);
          return { content: await readPlan(filePath) ?? null };
        }}
      />);

      await sendTuiLine(output, "/plan");
      await sendTuiLine(output, "Draft opened from command.");
      await waitForFrame(output, /Plan draft saved\./);
      await sendTuiLine(output, "/plan");
      await waitForFrame(output, /Current Plan/);
      const currentPlanFrame = output.lastFrame() ?? "";
      assert.match(currentPlanFrame, /Draft opened from command\./);
      assert.match(currentPlanFrame, /[.]session[\\/]plans[\\/]plan/);
      assert.match(currentPlanFrame, /[.]md/);
      assert.match(currentPlanFrame, /"\/plan open" to edit this plan in VS Code/);
      assert.ok(currentPlanFrame.indexOf("Draft opened from command.") < currentPlanFrame.indexOf("\"/plan open\" to edit this plan in VS Code"));
      await sendTuiLine(output, "/plan open");
      for (let index = 0; index < 20 && editedFiles.length === 0; index += 1) await settleTuiWork();

      assert.equal(editedFiles.length, 1);
      assert.match(editedFiles[0] ?? "", /[.]session[\\/]plans[\\/].+[.]md$/);
    } finally {
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
      output?.unmount();
      output?.cleanup();
    }
  });

  it("sends pasted image file attachments in ordinary Plan Mode messages", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-plan-prompt-image-");
    const imagePath = join(cwd, "prompt-feedback.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    output.stdin.write(`\u001b[200~Use this screenshot\n"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const imageRequest = await waitForImageFeedbackRequest(requests);
    const imageMessage = imageRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.equal(starts, 0);
    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[0] : undefined, { type: "text", text: "Use this screenshot" });
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("requests plan approval through ExitPlanMode and starts workflow only after approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown, option: unknown) { inputs.push(input); options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    assert.equal(inputs.length, 0);
    assert.match(output.lastFrame() ?? "", /Here is Claude's plan:/);
    assert.match(output.lastFrame() ?? "", /Draft the migration first\./);
    output.stdin.write("\r");
    await settleTuiWork();

    assert.equal(inputs.length, 1);
    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first."
    });
    assert.deepEqual(options[0], { permissionMode: "acceptEdits" });

    output.unmount();
    output.cleanup();
  });

  it("shows the clear-context approval option when the Plan Mode setting is enabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    assert.match(output.lastFrame() ?? "", /Yes, clear context and auto-accept edits/);
    output.stdin.write("\r");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "acceptEdits", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("shows context usage on clear-context Plan approval when model usage and context window are known", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={configWithContextWindow}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={usagePlanProviderFactory}
      settings={{ showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    assert.match(output.lastFrame() ?? "", /Yes, clear context \(25% used\) and auto-accept edits/);

    output.unmount();
    output.cleanup();
  });

  it("uses bypass approval options when Plan Mode was entered from bypass permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "bypassPermissions" }, showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Yes, clear context and bypass permissions/);
    assert.match(frame, /Yes, and bypass permissions/);
    output.stdin.write("\r");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "bypassPermissions", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("uses auto approval options when Plan Mode was entered from auto mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "auto" }, showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Yes, clear context and use auto mode/);
    assert.match(frame, /Yes, and use auto mode/);
    output.stdin.write("\r");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "auto", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("does not inject Auto Mode instructions during Plan Mode when useAutoModeDuringPlan is disabled", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { throw new Error("workflow must not start before approval"); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      settings={{ permissions: { defaultMode: "auto" }, useAutoModeDuringPlan: false }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    const request = await waitForRequest(requests, "Draft the migration first.");
    const text = requestText(request);

    assert.match(text, /ATTACHMENT plan_mode/);
    assert.doesNotMatch(text, /ATTACHMENT auto_mode/);

    output.unmount();
    output.cleanup();
  });

  it("approves a non-empty auto-mode plan with auto-accept edits on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "auto" } }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "acceptEdits" });

    output.unmount();
    output.cleanup();
  });

  it("approves a non-empty auto-mode plan with clear context and auto-accept edits on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={planProviderFactory}
      settings={{ permissions: { defaultMode: "auto" }, showClearContextOnPlanAccept: true }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "acceptEdits", clearContext: true });

    output.unmount();
    output.cleanup();
  });

  it("shows ExitPlanMode requested permissions and preserves them in the approved handoff", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready with permissions.");
    await waitForFrame(output, /Ready to code\?/);

    assert.equal(inputs.length, 0);
    assert.match(output.lastFrame() ?? "", /Requested permissions:/);
    assert.match(output.lastFrame() ?? "", /Bash\(prompt: run tests\)/);

    output.stdin.write("\r");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first.",
      plan_requested_permissions: [{ tool: "Bash", prompt: "run tests" }]
    });

    output.unmount();
    output.cleanup();
  });

  it("opens the pending approval plan with Ctrl+G before approving", async (t) => {
    const previousEditor = process.env.EDITOR;
    const previousVisual = process.env.VISUAL;
    process.env.EDITOR = "code";
    process.env.VISUAL = "";
    t.after(() => {
      if (previousEditor === undefined) delete process.env.EDITOR;
      else process.env.EDITOR = previousEditor;
      if (previousVisual === undefined) delete process.env.VISUAL;
      else process.env.VISUAL = previousVisual;
    });
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const requests: ModelRequest[] = [];
    const editedFiles: string[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editPlanFile={async (filePath) => {
        editedFiles.push(filePath);
        await writePlan(filePath, "Edited migration plan from editor.\n");
        return { content: "Edited migration plan from editor.\n" };
      }}
      planSavedMessageDurationMs={500}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    const draftRequest = await waitForRequest(requests, "Draft the migration first.");
    const planFilePath = planFilePathFromRequest(draftRequest);
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    assert.match(output.lastFrame() ?? "", /Here is Claude's plan:/);
    assert.match(output.lastFrame() ?? "", /ctrl-g to edit in VS Code/);
    assert.ok((output.lastFrame() ?? "").includes(relative(cwd, planFilePath)));

    output.stdin.write("\u0007");
    await waitForFrame(output, /Plan saved!/);
    await waitForPlanSavedMessageToHide();
    assert.doesNotMatch(output.lastFrame() ?? "", /Plan saved!/);

    output.stdin.write("\r");
    await settleTuiWork();

    assert.deepEqual(editedFiles, [planFilePath]);
    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Edited migration plan from editor.",
      plan_file_path: planFilePath
    });

    output.unmount();
    output.cleanup();
  });

  it("approves a non-empty plan with auto-accept edits on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, _input: unknown, option: unknown) { options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    assert.equal(options.length, 0);

    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assert.deepEqual(options[0], { permissionMode: "acceptEdits" });

    output.unmount();
    output.cleanup();
  });

  it("approves a plan with typed approval feedback on Shift+Tab", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown, option: unknown) { inputs.push(input); options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Also update the README.");
    await settleTuiWork();
    assert.match(output.lastFrame() ?? "", /No, keep planning: Also update the README\./);
    output.stdin.write("\u001b[Z");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first.",
      plan_approval_feedback: "Also update the README."
    });
    assert.deepEqual(options[0], { permissionMode: "acceptEdits" });

    output.unmount();
    output.cleanup();
  });

  it("preserves typed approval feedback when approving from a Yes option", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const options: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown, option: unknown) { inputs.push(input); options.push(option); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Also update the README.");
    await settleTuiWork();
    output.stdin.write("\u001b[A");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first.",
      plan_approval_feedback: "Also update the README."
    });
    assert.deepEqual(options[0], { permissionMode: "default" });

    output.unmount();
    output.cleanup();
  });

  it("does not carry image-only approval feedback when approving from a Yes option", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[200~data:image/png;base64,iVBORw0KGgo=\u001b[201~");
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\u001b[A");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    assertApprovedPlanHandoff(inputs[0], {
      original_input: { request: "Draft the migration first." },
      approved_plan: "Draft the migration first."
    });

    output.unmount();
    output.cleanup();
  });

  it("rejects a pending plan approval on Escape and continues Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b");
    await settleTerminalEscape();
    await waitForFrame(output, /Plan Review \(needs revision\)/);

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /PLAN > Type a request or \/help/);
    await waitForRequestContaining(requests, /The agent proposed a plan that was rejected by the user/);

    output.unmount();
    output.cleanup();
  });

  it("re-enters Plan Mode with the previous approved plan file and re-entry guidance", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    assert.equal(inputs.length, 1);

    await sendTuiLine(output, "/plan Revisit the same task.");
    const reentryRequest = await waitForRequest(requests, "Revisit the same task.");
    const text = requestText(reentryRequest);

    assert.match(text, /ATTACHMENT plan_mode_reentry/);
    assert.match(text, /## Re-entering Plan Mode/);
    assert.match(text, /previously exited it/);
    assert.match(text, /ATTACHMENT plan_mode/);
    assert.match(text, /Current draft:/);
    assert.match(text, /Draft the migration first\./);

    output.unmount();
    output.cleanup();
  });

  it("approves exiting Plan Mode without a written plan and starts workflow with original input", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Ready empty exit.");
    await waitForFrame(output, /Exit plan mode\?/);

    assert.match(output.lastFrame() ?? "", /Claude wants to exit plan mode/);
    assert.equal(inputs.length, 0);

    output.stdin.write("\r");
    await settleTuiWork();

    assert.deepEqual(inputs[0], { request: "Ready empty exit.", [planModeExitHandoffMarker]: true, [planModeExitPlanExistsMarker]: false });

    output.unmount();
    output.cleanup();
  });

  it("continues planning after rejecting an empty Plan Mode exit", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Ready empty exit.");
    await waitForFrame(output, /Exit plan mode\?/);
    const requestCount = requests.length;

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    const rejectionRequest = await waitForRequestContaining(requests.slice(requestCount), /The agent proposed a plan that was rejected by the user/);
    const rejectionText = requestText(rejectionRequest);

    assert.equal(starts, 0);
    assert.match(rejectionText, /Rejected plan:/);
    assert.match(rejectionText, /\(empty plan\)/);
    assert.match(rejectionText, /User feedback:/);
    assert.match(rejectionText, /\(no feedback provided\)/);

    output.unmount();
    output.cleanup();
  });

  it("continues Plan Mode after answering AskUserQuestion", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Staged/);

    assert.equal(starts, 0);
    assert.ok(answerRequest.messages.some((message) => message.role === "assistant" && message.tool_calls?.some((call) => call.name === "AskUserQuestion")));
    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content))));
    assert.match(output.lastFrame() ?? "", /Planning staged rollout/);

    output.unmount();
    output.cleanup();
  });

  it("keeps single AskUserQuestion questions out of the submit tab flow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);

    output.stdin.write("\t");
    await settleTuiWork();
    assert.doesNotMatch(output.lastFrame() ?? "", /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Staged/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("lets the user chat about an AskUserQuestion directly from the question page", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);
    assert.match(output.lastFrame() ?? "", /Chat about this/);
    assert.doesNotMatch(output.lastFrame() ?? "", /3\. Chat about this/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Skip interview/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Planning:/);

    for (let index = 0; index < 2; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /The user wants to clarify these questions/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Start by asking them what they would like to clarify/);
    assert.match(answerText, /Which rollout path\?/);

    output.unmount();
    output.cleanup();
  });

  it("lets the user skip the AskUserQuestion interview directly from the question page", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);
    assert.match(output.lastFrame() ?? "", /Skip interview and plan/);
    assert.match(output.lastFrame() ?? "", /immediately/);

    for (let index = 0; index < 3; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /provided enough answers for the plan interview/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Stop asking clarifying questions/);
    assert.match(answerText, /Which rollout path\?/);

    output.unmount();
    output.cleanup();
  });

  it("rejects AskUserQuestion on Escape and continues Plan Mode", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Which rollout path\?/);

    output.stdin.write("\u001b");
    const rejectionRequest = await waitForToolAnswerRequest(requests, /doesn't want to proceed with this tool use/);

    assert.equal(starts, 0);
    assert.match(requestText(rejectionRequest), /"rejected":true/);
    await waitForFrame(output, /Planning without that answer\./);

    output.unmount();
    output.cleanup();
  });

  it("collects multiple AskUserQuestion questions before returning answers to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content)))), false);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Submit answers/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Which verification steps/.test(String(message.content)))), false);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Which verification steps/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /User has answered your questions:/);
    assert.match(answerText, /"Which rollout path\?"="Staged"/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests"/);
    assert.match(answerText, /You can now continue with the user's answers in mind\./);
    await waitForFrame(output, /Planning multi-question answer/);

    output.unmount();
    output.cleanup();
  });

  it("shows tui-code style AskUserQuestion submit review actions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Ready to submit your answers\?/);
    assert.match(output.lastFrame() ?? "", /Submit answers/);
    assert.match(output.lastFrame() ?? "", /Cancel/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Respond to Claude/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Finish plan interview/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Back to questions/);

    output.unmount();
    output.cleanup();
  });

  it("warns when AskUserQuestion submit review has unanswered questions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\t");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    output.stdin.write("\t");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);

    assert.match(output.lastFrame() ?? "", /You have not answered all questions/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /User has answered your questions/.test(String(message.content)))), false);

    output.unmount();
    output.cleanup();
  });

  it("cancels the Plan Mode AskUserQuestion interview from review", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /Cancel/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /doesn't want to proceed with this tool use/);
    const answerText = requestText(feedbackRequest);

    assert.match(answerText, /"rejected":true/);
    assert.doesNotMatch(answerText, /Which rollout path\?=/);

    output.unmount();
    output.cleanup();
  });

  it("returns to a previous AskUserQuestion before submitting multi-question answers", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /Previous question/);

    for (let index = 0; index < 3; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content)))), false);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Which verification steps/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /"Which rollout path\?"="Big bang"/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests"/);

    output.unmount();
    output.cleanup();
  });

  it("navigates multi-question AskUserQuestion tabs without submitting answers early", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need two questions.");
    await waitForFrame(output, /Question 1\/2: Which rollout path\?/);
    assert.match(output.lastFrame() ?? "", /☐ Rollout/);
    assert.match(output.lastFrame() ?? "", /☐ Verify/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /☒ Rollout/);
    assert.match(output.lastFrame() ?? "", /☐ Verify/);

    output.stdin.write("\t");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    assert.match(output.lastFrame() ?? "", /✓ Submit/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Which rollout path/.test(String(message.content)))), false);

    output.stdin.write("\u001b[D");
    await settleTuiWork();
    await waitForFrame(output, /Question 2\/2: Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    await waitForFrame(output, /Review your answers/);
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Which verification steps/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /"Which rollout path\?"="Staged"/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests"/);

    output.unmount();
    output.cleanup();
  });

  it("returns freeform AskUserQuestion answers as the Other option", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need freeform choice.");
    await waitForFrame(output, /Deployment window\?/);

    assert.match(output.lastFrame() ?? "", /Other/);
    await sendTuiLine(output, "Saturday night");
    const answerRequest = await waitForToolAnswerRequest(requests, /Saturday night/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Saturday night/);
    assert.match(answerText, /"Deployment window\?"="Saturday night"/);
    assert.doesNotMatch(answerText, /"question_id"/);
    assert.doesNotMatch(answerText, /"option_value"/);

    output.unmount();
    output.cleanup();
  });

  it("edits AskUserQuestion Other input with Ctrl+G before submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const editedInputs: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editQuestionText={(text) => {
        editedInputs.push(text);
        return { content: "Saturday night" };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need freeform choice.");
    await waitForFrame(output, /Deployment window\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u0007");
    await waitForFrame(output, /Saturday night/);
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Saturday night/);

    assert.deepEqual(editedInputs, [""]);
    assert.match(requestText(answerRequest), /"Deployment window\?"="Saturday night"/);

    output.unmount();
    output.cleanup();
  });

  it("returns AskUserQuestion image attachments with Other answers", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-question-image-");
    const imagePath = join(cwd, "question-feedback.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need freeform choice.");
    await waitForFrame(output, /Deployment window\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(`\u001b[200~"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const answerRequest = await waitForImageFeedbackRequest(requests);
    const answerText = requestText(answerRequest);
    const imageMessage = answerRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.match(answerText, /\(Image attached\)/);
    assert.match(answerText, /"Deployment window\?"="\(Image attached\)"/);
    assert.doesNotMatch(answerText, /"question_id"/);
    assert.doesNotMatch(answerText, /"option_value"/);
    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("returns selected AskUserQuestion preview content to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Phase 1/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Staged/.test(String(message.content)) && /Phase 1/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("focuses AskUserQuestion preview options with number keys without submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("2");
    await settleTuiWork();
    await waitForFrame(output, /All users/);
    assert.equal(requests.some((request) => request.messages.some((message) => message.role === "tool" && /Big bang/.test(String(message.content)))), false);

    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /All users/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Big bang/.test(String(message.content)) && /All users/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("returns AskUserQuestion preview notes to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);
    assert.match(output.lastFrame() ?? "", /press n to add notes/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    await waitForFrame(output, /All users/);
    output.stdin.write("n");
    await settleTuiWork();
    await waitForFrame(output, /Add notes on this design/);
    await sendTuiLine(output, "Only if rollback is instant.");
    const answerRequest = await waitForToolAnswerRequest(requests, /rollback is instant/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Big bang/);
    assert.match(answerText, /All users/);
    assert.match(answerText, /rollback is instant/);
    assert.match(answerText, /"Which rollout path\?"="Big bang"/);
    assert.match(answerText, /selected preview:\nAll users/);
    assert.match(answerText, /user notes: Only if rollback is instant\./);

    output.unmount();
    output.cleanup();
  });

  it("edits AskUserQuestion preview notes with Ctrl+G before submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const editedInputs: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editQuestionText={(text) => {
        editedInputs.push(text);
        return { content: "Edited notes from external editor." };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need clarification before planning.");
    await waitForFrame(output, /Phase 1/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    await waitForFrame(output, /All users/);
    output.stdin.write("n");
    await settleTuiWork();
    await waitForFrame(output, /Add notes on this design/);
    output.stdin.write("\u0007");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Edited notes from external editor/);
    const answerText = requestText(answerRequest);

    assert.deepEqual(editedInputs, [""]);
    assert.match(answerText, /Big bang/);
    assert.match(answerText, /All users/);
    assert.match(answerText, /Edited notes from external editor/);
    assert.match(answerText, /"Which rollout path\?"="Big bang"/);
    assert.match(answerText, /selected preview:\nAll users/);
    assert.match(answerText, /user notes: Edited notes from external editor\./);

    output.unmount();
    output.cleanup();
  });

  it("returns multiple AskUserQuestion selections to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);
    const questionFrame = output.lastFrame() ?? "";
    assert.match(questionFrame, /Planning:/);
    assert.match(questionFrame, /\.session/);
    const planningLine = questionFrame.split(/\r?\n/).find((line) => line.includes("Planning:")) ?? "";
    assert.equal(planningLine.includes(cwd), false);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Unit tests/);

    assert.ok(answerRequest.messages.some((message) => message.role === "tool" && /Unit tests/.test(String(message.content)) && /Manual smoke/.test(String(message.content))));

    output.unmount();
    output.cleanup();
  });

  it("lets the user chat about a multi-select AskUserQuestion directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /Chat about this/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Done/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Submit/);
    assert.match(output.lastFrame() ?? "", /Submit/);
    assert.match(output.lastFrame() ?? "", /4\. Chat about this/);
    assert.match(output.lastFrame() ?? "", /5\. Skip interview and plan immediately/);
    assert.doesNotMatch(output.lastFrame() ?? "", /\[ \] Chat about this/);

    for (let index = 0; index < 4; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /The user wants to clarify these questions/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Start by asking them what they would like to clarify/);
    assert.match(answerText, /Which verification steps\?/);
    assert.doesNotMatch(answerText, /option_values/);

    output.unmount();
    output.cleanup();
  });

  it("lets the user skip a multi-select AskUserQuestion interview directly", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);
    assert.match(output.lastFrame() ?? "", /Skip interview and plan/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Done/);
    assert.doesNotMatch(output.lastFrame() ?? "", /4\. Submit/);
    assert.match(output.lastFrame() ?? "", /Submit/);
    assert.match(output.lastFrame() ?? "", /4\. Chat about this/);
    assert.match(output.lastFrame() ?? "", /5\. Skip interview and plan immediately/);
    assert.doesNotMatch(output.lastFrame() ?? "", /\[ \] Skip interview/);

    for (let index = 0; index < 5; index += 1) {
      output.stdin.write("\u001b[B");
      await settleTuiWork();
    }
    output.stdin.write("\r");
    await settleTuiWork();

    const feedbackRequest = await waitForToolAnswerRequest(requests, /provided enough answers for the plan interview/);
    const answerText = requestText(feedbackRequest);

    assert.equal(starts, 0);
    assert.match(answerText, /Stop asking clarifying questions/);
    assert.match(answerText, /Which verification steps\?/);
    assert.doesNotMatch(answerText, /option_values/);

    output.unmount();
    output.cleanup();
  });

  it("returns multi-select AskUserQuestion Other input to the model", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("Accessibility pass");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Accessibility pass/);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Unit tests/);
    assert.match(answerText, /Accessibility pass/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests, Accessibility pass"/);
    assert.doesNotMatch(answerText, /"option_values"/);

    output.unmount();
    output.cleanup();
  });

  it("edits multi-select AskUserQuestion Other input with Ctrl+G before submitting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const editedInputs: string[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp
      cwd={cwd}
      config={config}
      workflows={["delivery"]}
      workflowId="delivery"
      engine={engine as never}
      providerFactory={recordingPlanProviderFactory(requests)}
      editQuestionText={(text) => {
        editedInputs.push(text);
        return { content: "Accessibility pass" };
      }}
    />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u0007");
    await waitForFrame(output, /Accessibility pass/);
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();
    const answerRequest = await waitForToolAnswerRequest(requests, /Accessibility pass/);

    assert.deepEqual(editedInputs, [""]);
    assert.match(requestText(answerRequest), /"Which verification steps\?"="Unit tests, Accessibility pass"/);

    output.unmount();
    output.cleanup();
  });

  it("returns multi-select AskUserQuestion image attachments with Other input", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-question-multi-image-");
    const imagePath = join(cwd, "verification-feedback.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Need multiple choices.");
    await waitForFrame(output, /Which verification steps\?/);

    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(`\u001b[200~"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");

    const answerRequest = await waitForImageFeedbackRequest(requests);
    const answerText = requestText(answerRequest);

    assert.match(answerText, /Unit tests/);
    assert.match(answerText, /\(Image attached\)/);
    assert.match(answerText, /"Which verification steps\?"="Unit tests, \(Image attached\)"/);
    assert.doesNotMatch(answerText, /"option_values"/);
    assert.ok(answerRequest.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")));

    output.unmount();
    output.cleanup();
  });

  it("keeps planning with typed feedback during plan approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    assert.match(output.lastFrame() ?? "", /Tell Claude what to change/);
    assert.match(output.lastFrame() ?? "", /shift\+tab to approve with this feedback/);

    const feedback = "Split the migration into two smaller phases.";
    await sendTuiLine(output, feedback);
    const feedbackRequest = await waitForRequestContaining(requests, /Split the migration into two smaller phases\./);
    const feedbackRequestText = requestText(feedbackRequest);
    await waitForFrame(output, /Split the migration into two smaller phases\./);
    const frame = output.lastFrame() ?? "";

    assert.equal(starts, 0);
    assert.match(frame, /Plan Mode/);
    assert.match(frame, /Plan Review \(needs revision\)/);
    assert.match(frame, /User feedback: Split the migration into two smaller phases\./);
    assert.match(frame, /PLAN > Type a request or \/help/);
    assert.doesNotMatch(frame, /Type a request or \/help[^\n]*smaller phases/);
    assert.doesNotMatch(frame, /Ctrl\+C stop[^\n]*smaller phases/);
    assert.match(feedbackRequestText, /The agent proposed a plan that was rejected by the user/);
    assert.match(feedbackRequestText, /Rejected plan:/);
    assert.match(feedbackRequestText, /Draft the migration first\./);
    assert.match(feedbackRequestText, /User feedback:/);
    assert.match(feedbackRequestText, /Split the migration into two smaller phases\./);

    output.unmount();
    output.cleanup();
  });

  it("keeps the plan approval open when No is submitted without feedback", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);
    const requestCount = requests.length;

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    const frame = output.lastFrame() ?? "";
    assert.equal(starts, 0);
    assert.equal(requests.length, requestCount);
    assert.match(frame, /Ready to code\?/);
    assert.match(frame, /WAITING_PLAN_REVIEW > Type a request or \/help/);
    assert.match(frame, /No, keep planning/);
    assert.match(frame, /Tell Claude what to change/);
    assert.doesNotMatch(frame, /needs revision/);

    output.unmount();
    output.cleanup();
  });

  it("preserves image feedback when rejecting a plan approval", () => {
    const message = planRejectionMessage("Update auth flow.", {
      answer: "Use this diagram.",
      contentBlocks: [{
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo="
        }
      }]
    });

    assert.equal(message.role, "user");
    assert.ok(Array.isArray(message.content));
    assert.match(message.content[0].type === "text" ? message.content[0].text : "", /Use this diagram/);
    assert.deepEqual(message.content[1], { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });
  });

  it("keeps planning with pasted image feedback during plan approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[200~Use this screenshot data:image/png;base64,iVBORw0KGgo=\u001b[201~");
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const feedbackRequest = await waitForImageFeedbackRequest(requests);
    const imageMessage = feedbackRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("keeps planning with pasted image file feedback during plan approval", async () => {
    const cwd = await makeProjectTmpCwd("agent-team-tui-plan-image-path-");
    const imagePath = join(cwd, "Screenshot Path.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgo=", "base64"));
    const requests: ModelRequest[] = [];
    const engine = { async startInteractive() { return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={recordingPlanProviderFactory(requests)} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "Ready for approval.");
    await waitForFrame(output, /Ready to code\?/);

    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write("\u001b[B");
    await settleTuiWork();
    output.stdin.write(`\u001b[200~"${imagePath}"\u001b[201~`);
    await waitForFrame(output, /1 image attached/);
    output.stdin.write("\r");

    const feedbackRequest = await waitForImageFeedbackRequest(requests);
    const imageMessage = feedbackRequest.messages.find((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image"));

    assert.ok(imageMessage);
    assert.deepEqual(Array.isArray(imageMessage.content) ? imageMessage.content[1] : undefined, { type: "image", media_type: "image/png", data: "iVBORw0KGgo=" });

    output.unmount();
    output.cleanup();
  });

  it("keeps Plan Mode draft across /clear", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { throw new Error("workflow must not start before approval"); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Keep this draft.");
    await sendTuiLine(output, "/clear");
    await sendTuiLine(output, "/plan");

    await waitForFrame(output, /Current Plan/);
    assert.match(output.lastFrame() ?? "", /Keep this draft/);
    assert.doesNotMatch(output.lastFrame() ?? "", /Ready to code\?/);

    output.unmount();
    output.cleanup();
  });


  it("renders long Plan approval documents in the approval dialog with choices visible", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-long-plan", cwd);
    const longPlan = Array.from({ length: 80 }, (_, index) => `Step ${String(index + 1).padStart(2, "0")}: verify the migration guardrail before executing.`).join(String.fromCharCode(10));
    await writePlan(planFilePath, `${longPlan}${String.fromCharCode(10)}`);
    await new SessionStore(join(cwd, ".session")).savePlanState("session-long-plan", {
      mode: "waiting_approval",
      sessionId: "session-long-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume long plan" }
    });
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { throw new Error("workflow must not start before approval"); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write(String.fromCharCode(13));
    await settleTuiWork();
    await waitForFrame(output, /Ready to code\?/);

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Here is Claude's plan:/);
    assert.match(frame, /Step 01: verify the migration guardrail before executing\./);
    assert.match(frame, /lines hidden/);
    assert.match(frame, /Claude has written up a plan and is ready to execute/);
    assert.match(frame, /Yes, auto-accept edits/);
    assert.match(frame, /Yes, manually approve edits/);
    assert.doesNotMatch(frame, /Yes, bypass permissions/);
    assert.match(frame, /No, keep planning/);

    output.stdin.write("\u001b[6~");
    await settleTuiWork();
    const pagedFrame = output.lastFrame() ?? "";
    assert.match(pagedFrame, /Step 02: verify the migration guardrail before executing\./);
    assert.match(pagedFrame, /previous line/);
    assert.match(pagedFrame, /Ready to code\?/);
    assert.match(pagedFrame, /Yes, auto-accept edits/);

    output.stdin.write("\u001b[5~");
    await settleTuiWork();
    assert.match(output.lastFrame() ?? "", /Step 01: verify the migration guardrail before executing\./);

    output.unmount();
    output.cleanup();
  });


  it("restores waiting Plan Mode sessions from /resume without starting workflow", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-plan", cwd);
    await writePlan(planFilePath, "Saved plan.\n");
    await new SessionStore(join(cwd, ".session")).savePlanState("session-plan", {
      mode: "waiting_approval",
      sessionId: "session-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume this" }
    });
    let starts = 0;
    let resumes = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { resumes += 1; return fakeSession(); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Ready to code\?/);
    assert.equal(starts, 0);
    assert.equal(resumes, 0);

    output.unmount();
    output.cleanup();
  });

  it("recovers missing waiting Plan Mode plan files from the transcript on /resume", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-plan-recover", cwd);
    const store = new SessionStore(join(cwd, ".session"));
    await store.savePlanState("session-plan-recover", {
      mode: "waiting_approval",
      sessionId: "session-plan-recover",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Recover this plan" }
    });
    await store.appendTranscript("session-plan-recover", {
      role: "assistant",
      content: "Writing the plan.",
      tool_calls: [{ id: "write-plan", name: "Write", input: { file_path: planFilePath, content: "# Recovered Plan\n\nUse transcript.\n" } }]
    });
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Ready to code\?/);
    assert.match(output.lastFrame() ?? "", /Claude has written up a plan and is ready to execute/);
    assert.doesNotMatch(output.lastFrame() ?? "", /without a written plan/);
    assert.equal(await readPlan(planFilePath), "# Recovered Plan\n\nUse transcript.\n");
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("restores Plan Mode transcript messages into the TUI log", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-planning-transcript", cwd);
    const store = new SessionStore(join(cwd, ".session"));
    await store.savePlanState("session-planning-transcript", {
      mode: "planning",
      sessionId: "session-planning-transcript",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume this planning session" }
    });
    await store.appendTranscript("session-planning-transcript", { role: "user", content: "Previously sent in Plan Mode." });
    await store.appendTranscript("session-planning-transcript", { role: "assistant", content: "Previously acknowledged." });
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} providerFactory={planProviderFactory} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Previously sent in Plan Mode\./);
    assert.match(output.lastFrame() ?? "", /Previously acknowledged\./);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });

  it("restores empty waiting Plan Mode sessions as exit confirmation", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const planFilePath = getPlanFilePath("session-empty-plan", cwd);
    await new SessionStore(join(cwd, ".session")).savePlanState("session-empty-plan", {
      mode: "waiting_approval",
      sessionId: "session-empty-plan",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "Resume empty plan" }
    });
    let starts = 0;
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { starts += 1; return fakeSession(); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/resume");
    await waitForFrame(output, /Resume workflow run/);
    output.stdin.write("\r");
    await settleTuiWork();

    await waitForFrame(output, /Exit plan mode\?/);
    assert.match(output.lastFrame() ?? "", /Claude wants to exit plan mode/);
    assert.equal(starts, 0);

    output.unmount();
    output.cleanup();
  });
});

function fakeSession() {
  const state = { status: "completed" as const, workflow_id: "delivery", attempts: [], handoff: undefined };
  return {
    runId: "run-approved-plan",
    state,
    events: (async function* () {})(),
    permissions: { resolve: () => undefined, resolveAll: () => undefined, hasPending: () => false },
    interrupt: async () => undefined,
    resumeWithUserInput: async () => undefined,
    continueWithInput: async () => undefined,
    result: Promise.resolve(state)
  };
}

function planProviderFactory(): ModelProvider {
  return planProvider();
}

function usagePlanProviderFactory(): ModelProvider {
  const provider = planProvider();
  return {
    async generate(request) {
      const response = await provider.generate(request);
      return { ...response, usage: { inputTokens: 250, outputTokens: 10, totalTokens: 260 } };
    }
  };
}

function recordingPlanProviderFactory(requests: ModelRequest[]): () => ModelProvider {
  return () => planProvider(requests);
}

function hangingPlanProviderFactory(): ModelProvider {
  return {
    async generate() {
      return new Promise(() => undefined);
    }
  };
}

function planProvider(requests?: ModelRequest[]): ModelProvider {
  return {
    async generate(request: ModelRequest) {
      requests?.push(request);
      const last = request.messages.at(-1);
      if (last?.role === "tool" && /Which verification steps/.test(String(last.content))) return { content: "Planning multi-question answer." };
      if (last?.role === "tool" && /Staged/.test(String(last.content))) return { content: "Planning staged rollout." };
      if (last?.role === "tool" && /Unit tests/.test(String(last.content))) return { content: "Planning selected verification." };
      if (last?.role === "tool" && /Saturday night/.test(String(last.content))) return { content: "Planning Saturday rollout." };
      if (last?.role === "tool" && /Accessibility pass/.test(String(last.content))) return { content: "Planning extra verification." };
      if (last?.role === "tool" && /staged rollout/.test(String(last.content))) return { content: "Planning staged rollout." };
      if (last?.role === "tool" && /doesn't want to proceed with this tool use/.test(String(last.content))) return { content: "Planning without that answer." };
      if (last?.role === "tool") return { content: "Plan draft saved." };
      const planFilePath = planFilePathFromRequest(request);
      const userText = [...request.messages].reverse().find((message) => message.role === "user" && typeof message.content === "string" && !message.content.includes("ATTACHMENT plan_mode"))?.content;
      if (typeof userText === "string" && userText.includes("Need clarification")) {
        return {
          content: "Need clarification.",
          tool_calls: [{
            id: "tool-question",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which rollout path?",
                header: "Rollout",
                options: [
                  { label: "Staged", description: "Release gradually", preview: "Phase 1\nPhase 2" },
                  { label: "Big bang", description: "Release all at once", preview: "All users" }
                ]
              }]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Need two questions")) {
        return {
          content: "Need two answers.",
          tool_calls: [{
            id: "tool-question-two",
            name: "AskUserQuestion",
            input: {
              questions: [
                {
                  question: "Which rollout path?",
                  header: "Rollout",
                  options: [
                    { label: "Staged", description: "Release gradually" },
                    { label: "Big bang", description: "Release all at once" }
                  ]
                },
                {
                  question: "Which verification steps?",
                  header: "Verify",
                  options: [
                    { label: "Unit tests", description: "Run focused automated tests" },
                    { label: "Manual smoke", description: "Try the TUI interaction manually" }
                  ]
                }
              ]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Need multiple choices")) {
        return {
          content: "Need multiple choices.",
          tool_calls: [{
            id: "tool-question-multi",
            name: "AskUserQuestion",
            input: {
              questions: [{
                question: "Which verification steps?",
                header: "Verify",
                multiSelect: true,
                options: [
                  { label: "Unit tests", description: "Run focused automated tests" },
                  { label: "Manual smoke", description: "Try the TUI interaction manually" }
                ]
              }]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Need freeform choice")) {
        return {
          content: "Need freeform choice.",
          tool_calls: [{
            id: "tool-question-freeform",
            name: "AskUserQuestion",
            input: {
              questions: [{
                id: "window",
                question: "Deployment window?",
                header: "Window",
                options: [
                  { label: "Weekday morning", description: "Lower staffing risk" },
                  { label: "Weekday evening", description: "Lower user traffic" }
                ]
              }]
            }
          }]
        };
      }
      if (typeof userText === "string" && userText.includes("Ready with permissions")) {
        return {
          content: "Requesting approval with permissions.",
          tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: { allowedPrompts: [{ tool: "Bash", prompt: "run tests" }] } }]
        };
      }
      if (typeof userText === "string" && userText.includes("Ready empty exit")) {
        return {
          content: "Requesting empty exit.",
          tool_calls: [{ id: "tool-exit-plan-empty", name: "ExitPlanMode", input: {} }]
        };
      }
      if (typeof userText === "string" && userText.includes("Ready for approval")) {
        return {
          content: "Requesting approval.",
          tool_calls: [{ id: "tool-exit-plan", name: "ExitPlanMode", input: {} }]
        };
      }
      return {
        content: "Writing the plan draft.",
        tool_calls: [{ id: "tool-1", name: "Write", input: { file_path: planFilePath, content: String(userText ?? "Plan") } }]
      };
    }
  };
}

function planFilePathFromRequest(request: ModelRequest): string {
  const text = request.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
  const match = /Current plan file: (.+)/.exec(text);
  if (!match?.[1]) throw new Error("Plan file attachment missing");
  return match[1].trim();
}

async function sendTuiLine(output: { stdin: { write(value: string): void } }, text: string): Promise<void> {
  output.stdin.write(text);
  await settleTuiWork();
  output.stdin.write("\r");
  await settleTuiWork();
}

async function waitForFrame(output: { lastFrame(): string | undefined }, pattern: RegExp): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (pattern.test(output.lastFrame() ?? "")) return;
    await settleTuiWork();
  }
  assert.match(output.lastFrame() ?? "", pattern);
}

async function makeProjectTmpCwd(prefix: string): Promise<string> {
  const root = resolve(".tmp");
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, prefix));
}

async function waitForRequest(requests: ModelRequest[], text: string): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => item.messages.some((message) => message.role === "user" && message.content === text));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => item.messages.some((message) => message.role === "user" && message.content === text));
  assert.ok(request);
  return request;
}

async function waitForRequestContaining(requests: ModelRequest[], pattern: RegExp): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => pattern.test(requestText(item)));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => pattern.test(requestText(item)));
  assert.ok(request);
  return request;
}

async function waitForImageFeedbackRequest(requests: ModelRequest[]): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => item.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => item.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => part.type === "image")));
  assert.ok(request);
  return request;
}

async function waitForToolAnswerRequest(requests: ModelRequest[], pattern: RegExp): Promise<ModelRequest> {
  for (let index = 0; index < 20; index += 1) {
    const request = requests.find((item) => item.messages.some((message) => message.role === "tool" && pattern.test(String(message.content))));
    if (request) return request;
    await settleTuiWork();
  }
  const request = requests.find((item) => item.messages.some((message) => message.role === "tool" && pattern.test(String(message.content))));
  assert.ok(request);
  return request;
}

function requestText(request: ModelRequest): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content)).join("\n");
}

function assertApprovedPlanHandoff(actual: unknown, expected: Record<string, unknown>): void {
  assert.ok(actual && typeof actual === "object");
  const handoff = actual as Record<string, unknown>;
  assert.equal(typeof handoff.plan_file_path, "string");
  assert.ok(String(handoff.plan_file_path).trim());
  assert.deepEqual(handoff, {
    ...expected,
    plan_file_path: expected.plan_file_path ?? handoff.plan_file_path
  });
}

function settleTuiWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}

function settleTerminalEscape(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 35));
}

function waitForPlanSavedMessageToHide(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 550));
}
