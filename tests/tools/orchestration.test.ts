import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeToolCalls } from "../../src/tools/orchestration.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Tool } from "../../src/tools/types.js";

describe("executeToolCalls", () => {
  it("runs consecutive read-only concurrency-safe tools in parallel", async () => {
    const registry = new ToolRegistry();
    registry.add(delayedTool("ReadOne", 80, true));
    registry.add(delayedTool("ReadTwo", 80, true));
    registry.add(delayedTool("ReadThree", 80, true));

    const startedAt = Date.now();
    const results = await executeToolCalls([
      { id: "1", name: "ReadOne", input: {} },
      { id: "2", name: "ReadTwo", input: {} },
      { id: "3", name: "ReadThree", input: {} }
    ], registry, { cwd: process.cwd() });

    assert.equal(results.length, 3);
    assert.ok(Date.now() - startedAt < 180);
    assert.deepEqual(results.map((item) => item.result?.output), ["ReadOne", "ReadTwo", "ReadThree"]);
  });

  it("keeps write and non-concurrency-safe tools in original order", async () => {
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.add(recordingTool("ReadOne", true, events));
    registry.add(recordingTool("WriteOne", false, events));
    registry.add(recordingTool("ReadTwo", true, events));

    await executeToolCalls([
      { id: "1", name: "ReadOne", input: {} },
      { id: "2", name: "WriteOne", input: {} },
      { id: "3", name: "ReadTwo", input: {} }
    ], registry, { cwd: process.cwd() });

    assert.deepEqual(events, [
      "start:ReadOne",
      "end:ReadOne",
      "start:WriteOne",
      "end:WriteOne",
      "start:ReadTwo",
      "end:ReadTwo"
    ]);
  });

  it("stops after a user-interaction tool and does not execute later tools", async () => {
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.add(recordingTool("ReadOne", true, events));
    registry.add(interactiveTool("AskUserQuestion", events));
    registry.add(recordingTool("ReadAfterQuestion", true, events));

    const results = await executeToolCalls([
      { id: "1", name: "ReadOne", input: {} },
      { id: "2", name: "AskUserQuestion", input: {} },
      { id: "3", name: "ReadAfterQuestion", input: {} }
    ], registry, { cwd: process.cwd() });

    assert.deepEqual(results.map((item) => item.call.name), ["ReadOne", "AskUserQuestion"]);
    assert.deepEqual(events, [
      "start:ReadOne",
      "end:ReadOne",
      "start:AskUserQuestion",
      "end:AskUserQuestion"
    ]);
  });
});

function delayedTool(name: string, delayMs: number, concurrencySafe: boolean): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    isReadOnly: () => true,
    isConcurrencySafe: () => concurrencySafe,
    async execute() {
      await delay(delayMs);
      return { output: name };
    }
  };
}

function recordingTool(name: string, concurrencySafe: boolean, events: string[]): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    isReadOnly: () => concurrencySafe,
    isConcurrencySafe: () => concurrencySafe,
    async execute() {
      events.push(`start:${name}`);
      await delay(5);
      events.push(`end:${name}`);
      return { output: name };
    }
  };
}

function interactiveTool(name: string, events: string[]): Tool {
  return {
    name,
    description: name,
    input_schema: {},
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    requiresUserInteraction: () => true,
    async execute() {
      events.push(`start:${name}`);
      await delay(5);
      events.push(`end:${name}`);
      return { output: name, data: { type: "user_input_requested", questions: [] } };
    }
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
