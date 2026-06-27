import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { Tool } from "../../src/tools/types.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-permissions-"));
}

describe("checkToolPermission", () => {
  it("keeps default mode compatible with allow ask deny rules", async () => {
    const cwd = await workspace();

    assert.equal((await checkToolPermission(readTool, { file_path: "README.md" }, {
      mode: "default",
      allow: ["Read"],
      ask: [],
      deny: [],
      cwd
    })).decision, "allow");

    assert.equal((await checkToolPermission(readTool, { file_path: ".env" }, {
      mode: "default",
      allow: ["Read"],
      ask: [],
      deny: ["Read(.env)"],
      cwd
    })).decision, "deny");

    assert.equal((await checkToolPermission(bashTool, { command: "npm test" }, {
      mode: "default",
      allow: [],
      ask: ["Bash(npm test)"],
      deny: [],
      cwd
    })).decision, "ask");
  });

  it("allows non destructive tools in bypassPermissions but still honors deny rules", async () => {
    const cwd = await workspace();

    assert.equal((await checkToolPermission(readTool, { file_path: ".env" }, {
      mode: "bypassPermissions",
      allow: [],
      ask: [],
      deny: [],
      cwd
    })).decision, "allow");

    assert.equal((await checkToolPermission(bashTool, { command: "git reset --hard" }, {
      mode: "bypassPermissions",
      allow: [],
      ask: [],
      deny: ["Bash(git reset*)"],
      cwd
    })).decision, "deny");
  });

  it("allows read-only tools and rejects normal write tools in plan mode", async () => {
    const cwd = await workspace();

    assert.equal((await checkToolPermission(readTool, { file_path: "README.md" }, {
      mode: "plan",
      allow: [],
      ask: [],
      deny: [],
      cwd,
      planFilePath: ".session/plans/session-1.md"
    })).decision, "allow");

    const writeDecision = await checkToolPermission(writeTool, { file_path: "src/index.ts", content: "x" }, {
      mode: "plan",
      allow: [],
      ask: [],
      deny: [],
      cwd,
      planFilePath: ".session/plans/session-1.md"
    });
    assert.equal(writeDecision.decision, "deny");
    assert.match(writeDecision.reason ?? "", /Plan Mode/);
  });

  it("allows only the current session plan file in plan mode", async () => {
    const cwd = await workspace();
    const context = {
      mode: "plan" as const,
      allow: [],
      ask: [],
      deny: [],
      cwd,
      planFilePath: ".session/plans/session-1.md"
    };

    assert.equal((await checkToolPermission(writeTool, { file_path: ".session/plans/session-1.md", content: "plan" }, context)).decision, "allow");
    assert.equal((await checkToolPermission(writeTool, { file_path: ".session/plans/session-2.md", content: "plan" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(writeTool, { file_path: "README.md", content: "plan" }, context)).decision, "deny");
  });

  it("rejects shell writes git destructive commands and workflow execution in plan mode", async () => {
    const cwd = await workspace();
    const context = {
      mode: "plan" as const,
      allow: [],
      ask: [],
      deny: [],
      cwd,
      planFilePath: ".session/plans/session-1.md"
    };

    assert.equal((await checkToolPermission(bashTool, { command: "echo hi > out.txt" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(bashTool, { command: "git reset --hard" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(powerShellTool, { command: "Remove-Item out.txt" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(workflowRunTool, { workflow: "delivery" }, context)).decision, "deny");
  });
});

const readTool: Tool = {
  name: "Read",
  description: "read",
  input_schema: {},
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async execute() {
    return { output: "" };
  }
};

const writeTool: Tool = {
  name: "Write",
  description: "write",
  input_schema: {},
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive: () => true,
  writesPlanFile(input, context) {
    const path = String((input as { file_path?: unknown }).file_path ?? "");
    return path.startsWith(".session/plans/") && Boolean(context.cwd);
  },
  async execute() {
    return { output: "" };
  }
};

const bashTool: Tool = {
  name: "Bash",
  description: "bash",
  input_schema: {},
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isDestructive(input) {
    const command = String((input as { command?: unknown }).command ?? "").toLowerCase();
    return command.includes(">") || command.includes("git reset") || command.includes("rm ");
  },
  async execute() {
    return { output: "" };
  }
};

const powerShellTool: Tool = {
  ...bashTool,
  name: "PowerShell",
  isDestructive(input) {
    return String((input as { command?: unknown }).command ?? "").toLowerCase().includes("remove-item");
  }
};

const workflowRunTool: Tool = {
  name: "WorkflowRun",
  description: "run workflow",
  input_schema: {},
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async execute() {
    return { output: "" };
  }
};
