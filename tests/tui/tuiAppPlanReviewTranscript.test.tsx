import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";
import { getPlanFilePath, writePlan } from "../../src/plans/planFiles.js";
import { SessionStore } from "../../src/storage/sessionStore.js";

describe("TuiApp plan review transcript", () => {
  it("renders restored Plan Mode approvals in the active approval dialog", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-plan-transcript-"));
    const planFilePath = getPlanFilePath("session-plan-transcript", cwd);
    await writePlan(planFilePath, "# Plan\nreview from restored session\n");
    await new SessionStore(join(cwd, ".session")).savePlanState("session-plan-transcript", {
      mode: "waiting_approval",
      sessionId: "session-plan-transcript",
      planFilePath,
      prePlanMode: "default",
      originalInput: { request: "review plan" }
    });
    const engine = {
      async listRuns() { return []; },
      async startInteractive() { throw new Error("workflow must not start"); },
      async resumeInteractive() { throw new Error("workflow resume must not run for plan session"); }
    };
    const output = render(<TuiApp cwd={cwd} config={tuiConfig()} workflows={["delivery"]} workflowId="delivery" engine={engine as unknown as never} />);

    await sendTuiLine(output, "/resume");
    await settleTuiWork();
    output.stdin.write("\r");
    await settleTuiWork();

    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Ready to code\?/);
    assert.match(frame, /Here is Einstein's plan:/);
    assert.match(frame, /review from restored session/);
    assert.doesNotMatch(frame, /Ready to code\?.*\.session\/plans/);
    assert.doesNotMatch(frame, /scroll main window with mouse wheel or PageUp\/PageDown/);

    output.unmount();
    output.cleanup();
  });
});

function tuiConfig() {
  return {
    providers: {
      default: { type: "openai-compatible" as const, base_url: "https://api.example.test/v1", api_key_env: "TEST_API_KEY", default_model: "gpt-test", capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true } }
    },
    roles: {
      product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } }
    },
    workflows: {
      delivery: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] }
    }
  };
}

async function sendTuiLine(output: { stdin: { write(value: string): void } }, text: string): Promise<void> {
  output.stdin.write(text);
  await settleTuiWork();
  output.stdin.write("\r");
  await settleTuiWork();
}

function settleTuiWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
