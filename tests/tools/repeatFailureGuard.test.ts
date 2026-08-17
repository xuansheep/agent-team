import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolPolicyFailureResult } from "../../src/tools/errors.js";
import {
  DETERMINISTIC_TOOL_FAILURE_CATEGORIES,
  REPEAT_BLOCKED_FAILURE_CATEGORY,
  RepeatFailureGuard,
  isDeterministicToolFailure,
  repeatFailureKey,
  stableToolInput
} from "../../src/tools/repeatFailureGuard.js";

describe("RepeatFailureGuard", () => {
  it("records the first deterministic failure and blocks the second identical call", () => {
    const guard = new RepeatFailureGuard();
    const input = { path: "src/a.ts", options: { limit: 2 } };
    const failure = toolPolicyFailureResult(DETERMINISTIC_TOOL_FAILURE_CATEGORIES.inputValidation, "invalid limit", "limit");
    assert.equal(guard.check("Read", input), undefined);
    const first = guard.record("Read", input, failure);
    assert.deepEqual(repeatMetadata(first), { failure_count: 1, retry_blocked: false });

    const second = guard.check("Read", { options: { limit: 2 }, path: "src/a.ts" });
    assert.equal(failureCategory(second), REPEAT_BLOCKED_FAILURE_CATEGORY);
    assert.deepEqual(repeatMetadata(second), { failure_count: 2, retry_blocked: true });
    assert.equal((second?.data as { original_failure_category?: string }).original_failure_category,
      DETERMINISTIC_TOOL_FAILURE_CATEGORIES.inputValidation);
  });

  it("allows retries when the input or tool changes", () => {
    const guard = new RepeatFailureGuard();
    const failure = toolPolicyFailureResult(DETERMINISTIC_TOOL_FAILURE_CATEGORIES.unknownTool, "Unknown tool Missing", "Missing");
    guard.record("Missing", { query: "one" }, failure);
    assert.equal(guard.check("Missing", { query: "two" }), undefined);
    assert.equal(guard.check("OtherMissing", { query: "one" }), undefined);
  });

  it("normalizes object keys and JSON-compatible undefined values stably", () => {
    assert.equal(
      stableToolInput({ b: [1, undefined], omitted: undefined, a: { y: true, x: null } }),
      '{"a":{"x":null,"y":true},"b":[1,null]}'
    );
    assert.equal(repeatFailureKey("Read", { b: 2, a: 1 }), repeatFailureKey("Read", { a: 1, b: 2 }));
    assert.notEqual(repeatFailureKey("Read", { a: 1 }), repeatFailureKey("Write", { a: 1 }));
  });

  it("tracks only explicitly deterministic categories", () => {
    const deterministic = [
      DETERMINISTIC_TOOL_FAILURE_CATEGORIES.unknownTool,
      DETERMINISTIC_TOOL_FAILURE_CATEGORIES.inputValidation,
      DETERMINISTIC_TOOL_FAILURE_CATEGORIES.staticPermissionDenied,
      DETERMINISTIC_TOOL_FAILURE_CATEGORIES.planPolicyDenied,
      "shell.input.command_too_long",
      "shell.background.unmanaged"
    ];
    for (const category of deterministic) {
      assert.equal(isDeterministicToolFailure(toolPolicyFailureResult(category, category)), true, category);
    }
    for (const category of ["tool.permission.user_denied", "shell.timeout", "shell.interrupted", "shell.exit.nonzero"]) {
      assert.equal(isDeterministicToolFailure(toolPolicyFailureResult(category, category)), false, category);
    }
  });

  it("does not remember transient or ordinary shell failures", () => {
    for (const category of ["tool.permission.user_denied", "shell.timeout", "shell.interrupted", "shell.exit.nonzero"]) {
      const guard = new RepeatFailureGuard();
      const original = toolPolicyFailureResult(category, category);
      assert.equal(guard.record("Bash", { command: "npm test" }, original), original);
      assert.equal(guard.check("Bash", { command: "npm test" }), undefined);
    }
  });

  it("blocks a second recorded failure when preflight was omitted", () => {
    const guard = new RepeatFailureGuard();
    const failure = toolPolicyFailureResult(DETERMINISTIC_TOOL_FAILURE_CATEGORIES.planPolicyDenied, "Plan Mode blocks writes");
    guard.record("Write", { file_path: "a.ts" }, failure);
    const repeated = guard.record("Write", { file_path: "a.ts" }, failure);
    assert.equal(failureCategory(repeated), REPEAT_BLOCKED_FAILURE_CATEGORY);
    assert.deepEqual(repeatMetadata(repeated), { failure_count: 2, retry_blocked: true });
  });

  it("isolates activation state by instance and supports reset", () => {
    const first = new RepeatFailureGuard();
    const next = new RepeatFailureGuard();
    const failure = toolPolicyFailureResult(DETERMINISTIC_TOOL_FAILURE_CATEGORIES.staticPermissionDenied, "Denied by static rule");
    const input = { file_path: ".env" };
    first.record("Read", input, failure);
    assert.notEqual(first.check("Read", input), undefined);
    assert.equal(next.check("Read", input), undefined);
    first.reset();
    assert.equal(first.check("Read", input), undefined);
  });
});

function failureCategory(result: { data?: unknown } | undefined): string | undefined {
  return (result?.data as { failure_category?: string } | undefined)?.failure_category;
}

function repeatMetadata(result: { data?: unknown } | undefined): {
  failure_count?: number;
  retry_blocked?: boolean;
} {
  const data = result?.data as { failure_count?: number; retry_blocked?: boolean } | undefined;
  return { failure_count: data?.failure_count, retry_blocked: data?.retry_blocked };
}
