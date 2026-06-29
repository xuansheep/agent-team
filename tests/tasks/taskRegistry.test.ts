import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TaskRegistry } from "../../src/tasks/taskRegistry.js";
import { taskOutput } from "../../src/tasks/taskOutput.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

describe("TaskRegistry", () => {
  it("creates a background task and allows status queries", async () => {
    const release = deferred<void>();
    const registry = new TaskRegistry();
    registry.register("delayed", async () => {
      await release.promise;
      return { status: "completed", result: { ok: true }, output: "done" };
    });

    const task = registry.startTask({ kind: "delayed", input: { value: 1 } }, { cwd: process.cwd() });
    const initial = registry.getTask(task.id);

    assert.equal(initial.kind, "delayed");
    assert.ok(initial.status === "queued" || initial.status === "running");

    release.resolve();
    const completed = await registry.waitForTask(task.id);

    assert.equal(completed.status, "completed");
    assert.deepEqual(completed.result, { ok: true });
    assert.equal(taskOutput(completed), "done");
  });

  it("rejects duplicate task kinds", () => {
    const registry = new TaskRegistry();
    registry.register("local", async () => ({ status: "completed" }));

    assert.throws(() => registry.register("local", async () => ({ status: "completed" })), /Duplicate task kind local/);
  });

  it("does not start background task execution while Plan Mode is active", () => {
    const registry = new TaskRegistry();
    registry.register("local", async () => ({ status: "completed" }));

    assert.throws(() => registry.startTask({ kind: "local" }, {
      cwd: process.cwd(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [] }
    }), /Plan Mode must be approved/);
    assert.equal(registry.listTasks().length, 0);
  });

  it("does not let task input smuggle Plan Mode execution into the background", () => {
    const registry = new TaskRegistry();
    registry.register("local", async () => ({ status: "completed" }));

    assert.throws(() => registry.startTask({
      kind: "local",
      input: { permissions: { mode: "plan" } }
    }, { cwd: process.cwd() }), /Plan Mode must be approved/);
    assert.equal(registry.listTasks().length, 0);

    assert.throws(() => registry.startTask({
      kind: "local",
      input: { agent: { permissions: { mode: "plan" } } }
    }, { cwd: process.cwd() }), /Plan Mode must be approved/);
    assert.equal(registry.listTasks().length, 0);

    assert.throws(() => registry.startTask({
      kind: "local",
      input: { permissionMode: "plan" }
    }, { cwd: process.cwd() }), /Plan Mode must be approved/);
    assert.equal(registry.listTasks().length, 0);
  });
});
