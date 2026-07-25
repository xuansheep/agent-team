import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { checkToolPermission } from "../../src/permissions/checkToolPermission.js";
import { bashTool as localBashTool } from "../../src/tools/local/bash.js";
import { exitPlanModeTool } from "../../src/tools/local/exitPlanMode.js";
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

  it("allows tools in fullAccess mode but still honors deny rules", async () => {
    const cwd = await workspace();

    assert.equal((await checkToolPermission(readTool, { file_path: ".env" }, {
      mode: "fullAccess",
      allow: [],
      ask: [],
      deny: [],
      cwd
    })).decision, "allow");

    assert.equal((await checkToolPermission(bashTool, { command: "git reset --hard" }, {
      mode: "fullAccess",
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

  it("rejects ExitPlanMode outside plan mode before prompting for approval", async () => {
    const cwd = await workspace();

    const decision = await checkToolPermission(exitPlanModeTool, {}, {
      mode: "default",
      allow: [],
      ask: ["ExitPlanMode"],
      deny: [],
      cwd
    });

    assert.equal(decision.decision, "deny");
    assert.match(decision.reason ?? "", /You are not in plan mode/);
    assert.match(decision.reason ?? "", /only for exiting plan mode after writing a plan/);
  });

  it("denies TodoWrite in plan mode so the plan file remains the only writable surface", async () => {
    const cwd = await workspace();

    const decision = await checkToolPermission(todoWriteTool, { todos: [{ content: "Inspect code", status: "pending" }] }, {
      mode: "plan",
      allow: [],
      ask: [],
      deny: [],
      cwd,
      planFilePath: ".session/plans/session-1.md"
    });

    assert.equal(decision.decision, "deny");
    assert.match(decision.reason ?? "", /Plan Mode allows only read-only tools and the current plan file/);
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

  it("allows only read-only Bash commands in plan mode", async () => {
    const cwd = await workspace();
    const context = {
      mode: "plan" as const,
      allow: [],
      ask: [],
      deny: [],
      cwd,
      planFilePath: ".session/plans/session-1.md"
    };

    assert.equal((await checkToolPermission(localBashTool, { command: "pwd" }, context)).decision, "allow");
    assert.equal((await checkToolPermission(localBashTool, { command: "rg \"Plan Mode\" src" }, context)).decision, "allow");
    assert.equal((await checkToolPermission(localBashTool, { command: "pwd && ls -la" }, context)).decision, "allow");
    assert.equal((await checkToolPermission(localBashTool, { command: "rg \"Plan Mode\" src | head -20" }, context)).decision, "allow");
    assert.equal((await checkToolPermission(localBashTool, { command: "git status --short" }, context)).decision, "allow");
    assert.equal((await checkToolPermission(localBashTool, { command: "npm test" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(localBashTool, { command: "cat package.json > copy.json" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(localBashTool, { command: "rg foo src | tee out.txt" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(localBashTool, { command: "git reset --hard" }, context)).decision, "deny");
    assert.equal((await checkToolPermission(localBashTool, { command: "git reset --hard" }, context)).reason, "Plan Mode blocks shell execution");
  });
  it("denies a compound rm command in fullAccess before node or transient allows", async () => {
    const cwd = await workspace();
    const command = "cd /d/work/code-ai/random && (pkill -f \"http.server 8137\" 2>/dev/null; pkill -f \"8137\" 2>/dev/null); rm -f weather-desktop.png; rm -rf .playwright-mcp; ls -la";
    const decision = await checkToolPermission(bashTool, { command }, {
      mode: "fullAccess",
      allow: ["Bash", "Bash(rm *)"],
      transientAllow: ["Bash(*)"],
      ask: [],
      deny: ["Bash(rm *)"],
      cwd
    });

    assert.deepEqual(decision, { decision: "deny", rule: "Bash(rm *)" });
  });

  it("does not deny quoted rm text in fullAccess", async () => {
    const cwd = await workspace();
    assert.equal((await checkToolPermission(bashTool, { command: "echo \"rm -rf dist\"" }, {
      mode: "fullAccess",
      allow: [],
      ask: [],
      deny: ["Bash(rm *)"],
      cwd
    })).decision, "allow");
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

const todoWriteTool: Tool = {
  name: "TodoWrite",
  description: "todos",
  input_schema: {},
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
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
