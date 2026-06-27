import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelProvider } from "../../src/providers/types.js";
import { createLocalAgentTask } from "../../src/tasks/localAgentTask.js";
import { TaskRegistry } from "../../src/tasks/taskRegistry.js";

describe("local agent task", () => {
  it("runs in an independent runtime session", async () => {
    const seenSessionIds: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        seenSessionIds.push(request.context?.sessionId ?? "");
        return { content: "child done" };
      }
    };
    const parentMessages = [{ role: "user" as const, content: "parent request" }];
    const registry = new TaskRegistry();
    registry.register("local-agent", createLocalAgentTask());

    const task = registry.startTask({
      kind: "local-agent",
      parentSessionId: "parent-session",
      input: {
        provider,
        model: "test-model",
        messages: parentMessages,
        cwd: process.cwd()
      }
    }, { cwd: process.cwd() });
    const completed = await registry.waitForTask(task.id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.parentSessionId, "parent-session");
    assert.equal(completed.sessionId, `${task.id}:agent`);
    assert.deepEqual(seenSessionIds, [`${task.id}:agent`]);
    assert.equal(parentMessages.length, 1);
    assert.equal(completed.output, "child done");
  });
});
