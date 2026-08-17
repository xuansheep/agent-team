import assert from "node:assert/strict";
import test from "node:test";
import { modelRequestDiagnostics, stableDiagnosticHash } from "../../src/model/requestDiagnostics.js";
import type { ModelRequest } from "../../src/providers/types.js";

function request(): ModelRequest {
  return {
    model: "test",
    messages: [
      { role: "system", content: "stable system" },
      { role: "user", content: "dynamic input" }
    ],
    tools: [{
      name: "Read",
      description: "Read a file",
      input_schema: { required: ["path"], properties: { path: { type: "string" } }, type: "object" },
      async execute() { return {}; }
    }],
    context: {
      runId: "run",
      nodeId: "node",
      attempt: 1,
      sessionId: "session",
      threadId: "thread",
      turnId: "turn",
      promptCacheKey: "secret-cache-key"
    }
  };
}

test("stableDiagnosticHash normalizes object key order but preserves array order", () => {
  assert.equal(stableDiagnosticHash({ a: 1, b: 2 }), stableDiagnosticHash({ b: 2, a: 1 }));
  assert.notEqual(stableDiagnosticHash(["a", "b"]), stableDiagnosticHash(["b", "a"]));
});

test("modelRequestDiagnostics records hashes and counts without prompt contents", () => {
  const diagnostics = modelRequestDiagnostics(request(), "sampling", { providerId: "openai", durationMs: 12.4 });
  assert.equal(diagnostics.request_kind, "sampling");
  assert.equal(diagnostics.provider_id, "openai");
  assert.equal(diagnostics.tool_count, 1);
  assert.equal(diagnostics.message_count, 2);
  assert.equal(diagnostics.duration_ms, 12);
  assert.equal(diagnostics.continuation, false);
  assert.equal(diagnostics.continuation_attempted, false);
  assert.equal(diagnostics.continuation_outcome, "not_attempted");
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes("stable system"), false);
  assert.equal(serialized.includes("dynamic input"), false);
  assert.equal(serialized.includes("secret-cache-key"), false);
});

test("modelRequestDiagnostics preserves fallback semantics and hashes response ids", () => {
  const previousResponseId = "resp-secret-previous";
  const providerResponseId = "resp-secret-current";
  const diagnostics = modelRequestDiagnostics(request(), "sampling", {
    continuationAttempted: true,
    continuationOutcome: "fallback_rebuild",
    continuationInputMessageCount: 1,
    checkpointState: "usable",
    providerResponseId,
    continuationResponseId: previousResponseId
  });

  assert.equal(diagnostics.continuation, false);
  assert.equal(diagnostics.continuation_attempted, true);
  assert.equal(diagnostics.continuation_outcome, "fallback_rebuild");
  assert.equal(diagnostics.continuation_input_message_count, 1);
  assert.equal(diagnostics.checkpoint_state, "usable");
  assert.equal(diagnostics.provider_response_id_present, true);
  assert.equal(diagnostics.provider_response_id_hash, stableDiagnosticHash(providerResponseId));
  assert.equal(diagnostics.continuation_response_id_hash, stableDiagnosticHash(previousResponseId));
  const serialized = JSON.stringify(diagnostics);
  assert.equal(serialized.includes(previousResponseId), false);
  assert.equal(serialized.includes(providerResponseId), false);
});

test("modelRequestDiagnostics records an absent provider response id without a hash", () => {
  const diagnostics = modelRequestDiagnostics(request(), "sampling", { providerResponseId: null });

  assert.equal(diagnostics.provider_response_id_present, false);
  assert.equal(diagnostics.provider_response_id_hash, undefined);
});
