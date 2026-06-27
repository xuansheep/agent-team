import React from "react";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { getPlanFilePath, writePlan } from "../../src/plans/planFiles.js";
import { SessionStore } from "../../src/storage/sessionStore.js";

const config = {
  providers: { default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } } },
  roles: { product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } } },
  workflows: { delivery: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] } }
};

describe("TuiApp global Plan Mode", () => {
  it("enters Plan Mode before workflow execution and does not start workflow while drafting", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    let starts = 0;
    const engine = { async startInteractive() { starts += 1; return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");

    assert.equal(starts, 0);
    assert.match(output.lastFrame() ?? "", /Plan Mode/);
    assert.match(output.lastFrame() ?? "", /Plan draft updated/);

    output.unmount();
    output.cleanup();
  });

  it("requests plan approval on /plan and starts workflow only after approval", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const inputs: unknown[] = [];
    const engine = { async startInteractive(_config: unknown, _workflowId: string, input: unknown) { inputs.push(input); return fakeSession(); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Draft the migration first.");
    await sendTuiLine(output, "/plan");
    await waitForFrame(output, /Plan approval request/);

    assert.equal(inputs.length, 0);
    output.stdin.write("\r");
    await settleTuiWork();

    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0], { original_input: { request: "Draft the migration first." }, approved_plan: "Draft the migration first." });

    output.unmount();
    output.cleanup();
  });

  it("keeps Plan Mode draft across /clear", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-plan-"));
    const engine = { async startInteractive() { throw new Error("workflow must not start before approval"); } };
    const output = render(<TuiApp cwd={cwd} config={config} workflows={["delivery"]} workflowId="delivery" engine={engine as never} />);

    await sendTuiLine(output, "/plan");
    await sendTuiLine(output, "Keep this draft.");
    await sendTuiLine(output, "/clear");
    await sendTuiLine(output, "/plan");

    await waitForFrame(output, /Plan approval request/);
    assert.match(output.lastFrame() ?? "", /Keep this draft/);

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

    await waitForFrame(output, /Plan approval request/);
    assert.match(output.lastFrame() ?? "", /Saved plan/);
    assert.equal(starts, 0);
    assert.equal(resumes, 0);

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
    resumePlanReview: async () => undefined,
    revisePlan: async () => undefined,
    continueWithInput: async () => undefined,
    result: Promise.resolve(state)
  };
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

function settleTuiWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
