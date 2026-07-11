import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { render } from "ink-testing-library";
import { TuiApp } from "../../src/tui/TuiApp.js";

const config = {
  providers: {
    default: {
      type: "openai-compatible" as const,
      base_url: "https://api.example.test/v1",
      api_key: "test-key",
      default_model: "gpt-test",
      capabilities: { tool_calling: false, vision: false, streaming: false, json_schema_output: true }
    }
  },
  roles: {
    product: { description: "", system_prompt: "product", requires: { tool_calling: false, vision: false } }
  },
  workflows: {
    delivery: { nodes: [{ id: "product", role: "product", provider: "default", permission_mode: "default" as const }], edges: [] }
  }
};

describe("TuiApp permission persistence", () => {
  it("persists the mode selected from /permissions", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-permissions-"));
    const savedModes: string[] = [];
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        saveDefaultPermissionMode={async (mode) => { savedModes.push(mode); }}
      />
    );

    await chooseFullAccess(output);
    await waitForFrame(output, /Permission mode: Full access/);
    assert.deepEqual(savedModes, ["fullAccess"]);
    output.unmount();
    output.cleanup();
  });

  it("keeps the current mode when persistence fails", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-team-tui-permissions-"));
    const output = render(
      <TuiApp
        cwd={cwd}
        config={config}
        workflows={["delivery"]}
        workflowId="delivery"
        saveDefaultPermissionMode={async () => { throw new Error("disk unavailable"); }}
      />
    );

    await chooseFullAccess(output);
    await waitForFrame(output, /Failed to save permission mode: disk unavailable/);
    const frame = output.lastFrame() ?? "";
    assert.match(frame, /Default execution mode/);
    assert.doesNotMatch(frame, /Permission mode: Full access/);
    output.unmount();
    output.cleanup();
  });
});

async function chooseFullAccess(output: { stdin: { write(value: string): void }; lastFrame(): string | undefined }): Promise<void> {
  await sendLine(output, "/permissions");
  await waitForFrame(output, /Default execution mode/);
  output.stdin.write("\u001b[B");
  await settle();
  output.stdin.write("\r");
}

async function sendLine(output: { stdin: { write(value: string): void } }, text: string): Promise<void> {
  output.stdin.write(text);
  await settle();
  output.stdin.write("\r");
  await settle();
}

async function waitForFrame(output: { lastFrame(): string | undefined }, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (pattern.test(output.lastFrame() ?? "")) return;
    await settle();
  }
  assert.match(output.lastFrame() ?? "", pattern);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 25));
}
