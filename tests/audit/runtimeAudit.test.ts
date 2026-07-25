import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditEvent } from "../../src/audit/auditEvent.js";
import { TurnEngine } from "../../src/runtime/turnEngine.js";
import { ModelProvider } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Tool } from "../../src/tools/types.js";
import { isDestructiveShellCommand } from "../../src/security/shellSafety.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-runtime-audit-"));
}

describe("runtime audit", () => {
  it("audits permission decisions tool invocation and tool results", async () => {
    const auditEvents: AuditEvent[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { content: "checking", tool_calls: [{ id: "call-1", name: "Echo", input: { value: "ok" } }] };
        return { content: "done" };
      }
    };
    const tools = new ToolRegistry();
    tools.add(echoTool);

    const result = await new TurnEngine().execute({
      messages: [{ role: "user", content: "use a tool" }],
      model: "test-model",
      provider,
      tools,
      permissions: { mode: "default", allow: ["Echo"], ask: [], deny: [] },
      cwd: await workspace(),
      sessionId: "session-audit",
      runId: "run-audit",
      auditSink: (event) => { auditEvents.push(event); }
    });

    assert.equal(result.status, "completed");
    assert.equal(auditEvents.find((event) => event.type === "permission_decision")?.decision, "allow");
    assert.equal(auditEvents.find((event) => event.type === "tool_invocation")?.tool, "Echo");
    assert.equal(auditEvents.find((event) => event.type === "tool_result")?.status, "completed");
    assert.equal(auditEvents.find((event) => event.type === "tool_invocation")?.session_id, "session-audit");
  });

  it("audits ask decisions and callback denials before tool execution", async () => {
    const auditEvents: AuditEvent[] = [];
    let executions = 0;
    const tools = new ToolRegistry();
    tools.add({ ...echoTool, async execute() { executions += 1; return { output: "unexpected" }; } });

    const result = await new TurnEngine().execute({
      messages: [{ role: "user", content: "use a tool" }],
      model: "test-model",
      provider: oneToolProvider("Echo", { value: "ok" }),
      tools,
      permissions: { mode: "default", allow: [], ask: ["Echo"], deny: [] },
      cwd: await workspace(),
      sessionId: "session-deny",
      auditSink: (event) => { auditEvents.push(event); },
      permissionCallback: () => "deny"
    });

    assert.equal(result.status, "failed");
    assert.equal(executions, 0);
    assert.deepEqual(auditEvents.filter((event) => event.type === "permission_decision").map((event) => event.decision), ["ask", "deny"]);
    assert.equal(auditEvents.some((event) => event.type === "tool_invocation"), false);
  });

  it("does not run git reset without explicit approval", async () => {
    let executions = 0;
    const tools = new ToolRegistry();
    tools.add({
      name: "Bash",
      description: "fake bash",
      input_schema: {},
      isDestructive: isDestructiveShellCommand,
      async execute() {
        executions += 1;
        return { output: "approved" };
      }
    });

    const waiting = await new TurnEngine().execute({
      messages: [{ role: "user", content: "reset" }],
      model: "test-model",
      provider: oneToolProvider("Bash", { command: "git reset --hard" }),
      tools,
      permissions: { mode: "default", allow: [], ask: ["Bash(git reset*)"], deny: [] },
      cwd: await workspace(),
      sessionId: "session-reset"
    });

    assert.equal(waiting.status, "waiting_permission");
    assert.equal(executions, 0);

    let calls = 0;
    const approved = await new TurnEngine().execute({
      messages: [{ role: "user", content: "reset" }],
      model: "test-model",
      provider: {
        async generate() {
          calls += 1;
          if (calls === 1) return { content: "reset", tool_calls: [{ id: "call-reset", name: "Bash", input: { command: "git reset --hard" } }] };
          return { content: "done" };
        }
      },
      tools,
      permissions: { mode: "default", allow: [], ask: ["Bash(git reset*)"], deny: [] },
      cwd: await workspace(),
      sessionId: "session-reset-approved",
      permissionCallback: () => "allow"
    });

    assert.equal(approved.status, "completed");
    assert.equal(executions, 1);
  });

  it("audits and rejects normal writes shell execution and workflow execution in plan mode", async () => {
    for (const [tool, input] of [
      ["Write", { file_path: "src/index.ts", content: "x" }],
      ["Bash", { command: "echo hi > out.txt" }],
      ["WorkflowRun", { workflow: "delivery" }]
    ] as const) {
      const auditEvents: AuditEvent[] = [];
      const tools = new ToolRegistry();
      tools.add(blockedTool(tool));

      const result = await new TurnEngine().execute({
        messages: [{ role: "user", content: "plan only" }],
        model: "test-model",
        provider: oneToolProvider(tool, input),
        tools,
        permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
        cwd: await workspace(),
        sessionId: `session-plan-${tool}`,
        auditSink: (event) => { auditEvents.push(event); }
      });

      assert.equal(result.status, "failed");
      const decision = auditEvents.find((event) => event.type === "permission_decision");
      assert.equal(decision?.decision, "deny");
      assert.equal(decision?.tool, tool);
      assert.equal(auditEvents.some((event) => event.type === "tool_invocation"), false);
    }
  });
});

const echoTool: Tool = {
  name: "Echo",
  description: "Returns the provided value.",
  input_schema: {},
  async execute(input) {
    return { output: String((input as { value?: unknown }).value ?? "") };
  }
};

function oneToolProvider(name: string, input: unknown): ModelProvider {
  return {
    async generate() {
      return { content: "checking", tool_calls: [{ id: `call-${name}`, name, input }] };
    }
  };
}

function blockedTool(name: string): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: name === "Bash" ? isDestructiveShellCommand : () => true,
    writesPlanFile(input) {
      return String((input as { file_path?: unknown }).file_path ?? "").startsWith(".session/plans/");
    },
    async execute() {
      return { output: "unexpected" };
    }
  };
}
