import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WorkflowNodeConfig } from "../../src/config/schema.js";
import { buildNodeMessages } from "../../src/harness/context.js";
import {
  buildResumeHandoff,
  compactHandoffForModel,
  type HandoffContext,
  workflowDossierContext
} from "../../src/team/handoff.js";
import type { NodeResult } from "../../src/team/nodeResult.js";

describe("bounded workflow handoffs", () => {
  it("keeps only the latest result per node and exposes artifact references", () => {
    const context = workflowDossierContext({
      node_results: [
        dossierResult(3, "dev", "latest dev", "artifact-dev"),
        dossierResult(2, "product", "latest product", "artifact-product"),
        dossierResult(1, "dev", "stale dev", "artifact-stale")
      ]
    });

    assert.deepEqual(context.prior_results?.map((result) => [result.node_id, result.summary]), [
      ["product", "latest product"],
      ["dev", "latest dev"]
    ]);
    assert.deepEqual(context.references, [
      { node_id: "product", summary: "latest product", artifact_ids: ["artifact-product"] },
      { node_id: "dev", summary: "latest dev", artifact_ids: ["artifact-dev"] }
    ]);
    const serialized = JSON.stringify(context);
    assert.doesNotMatch(serialized, /stale dev|artifact-stale|document body/);
  });

  it("bounds repeated resume handoffs to the current and one previous layer", () => {
    let handoff: unknown = handoffLayer("seed", 0);
    for (let iteration = 1; iteration <= 20; iteration += 1) {
      handoff = buildResumeHandoff(handoff, handoffLayer(`iteration-${iteration}`, iteration));
    }

    const compacted = compactHandoffForModel(handoff) as HandoffContext;
    const previous = compacted.previous_handoff as HandoffContext | undefined;
    assert.equal(compacted.instruction, "iteration-20");
    assert.equal(previous?.instruction, "iteration-19");
    assert.equal(previous?.previous_handoff, undefined);
    assert.ok(JSON.stringify(compacted).length < 1_500);
  });

  it("normalizes legacy nested dossiers before building model messages", async () => {
    const legacy = {
      request: "repair the implementation",
      prior_dossier: {
        node_results: [dossierResult(5, "developer", "implementation complete", "artifact-code")]
      },
      previous_handoff: {
        request: "older request",
        prior_dossier: {
          node_results: [dossierResult(4, "product", "requirements complete", "artifact-spec")]
        },
        previous_handoff: {
          request: "obsolete request",
          prior_dossier: {
            node_results: [dossierResult(1, "researcher", "deep legacy marker", "artifact-obsolete")]
          }
        }
      }
    };

    const messages = await buildNodeMessages(
      { id: "tester", role: "tester", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Test.",
      legacy
    );
    const userMessage = messages.find((message) => message.role === "user");
    assert.equal(typeof userMessage?.content, "string");
    const payload = JSON.parse(String(userMessage?.content)) as {
      handoff: {
        prior_results?: Array<{ node_id: string; summary: string }>;
        previous_handoff?: {
          prior_results?: Array<{ node_id: string; summary: string }>;
          previous_handoff?: unknown;
        };
      };
    };

    assert.deepEqual(payload.handoff.prior_results?.map((result) => result.node_id), ["developer"]);
    assert.deepEqual(payload.handoff.previous_handoff?.prior_results?.map((result) => result.node_id), ["product"]);
    assert.equal(payload.handoff.previous_handoff?.previous_handoff, undefined);
    const serialized = JSON.stringify(payload.handoff);
    assert.doesNotMatch(serialized, /prior_dossier|deep legacy marker|artifact-obsolete/);
  });
});

function dossierResult(seq: number, nodeId: string, summary: string, artifactId: string) {
  return {
    seq,
    node_id: nodeId,
    attempt: 1,
    activation: 1,
    status: "completed",
    result: nodeResult(summary, artifactId)
  };
}

function nodeResult(summary: string, artifactId: string): NodeResult {
  return {
    direction: "forward",
    summary,
    document: "document body must stay in the full dossier",
    deliverables: [{ artifact_id: artifactId, description: summary }],
    feedback: { defects: [], change_requests: [] },
    questions: [],
    handoff: {
      instruction: summary,
      must_follow: [],
      known_risks: [],
      open_questions: []
    }
  };
}

function handoffLayer(instruction: string, iteration: number): HandoffContext {
  return {
    from: "bus",
    to: "dev",
    instruction,
    must_follow: [],
    known_risks: [],
    open_questions: [],
    references: [],
    iteration
  };
}
