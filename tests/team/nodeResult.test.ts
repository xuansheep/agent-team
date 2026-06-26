import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nodeResultJsonSchema, parseNodeResult } from "../../src/team/nodeResult.js";

describe("nodeResultJsonSchema", () => {
  it("requires every top-level property for strict structured output", () => {
    const properties = Object.keys(nodeResultJsonSchema.properties).sort();
    const required = [...nodeResultJsonSchema.required].sort();

    assert.deepEqual(required, properties);
  });

  it("defaults document to an empty string when omitted", () => {
    const result = parseNodeResult(JSON.stringify({ status: "success", summary: "done" }));

    assert.equal(result.document, "");
  });

  it("extracts a fenced JSON NodeResult from provider prose", () => {
    const result = parseNodeResult(`The task is done.

\`\`\`json
{
  "status": "success",
  "summary": "done",
  "document": "",
  "deliverables": [],
  "feedback": { "defects": [], "change_requests": [] },
  "questions": [],
  "handoff": { "instruction": "next", "must_follow": [], "known_risks": [], "open_questions": [] }
}
\`\`\``);

    assert.equal(result.status, "success");
    assert.equal(result.handoff.instruction, "next");
  });

  it("rejects extracted JSON with non-NodeResult fields", () => {
    assert.throws(
      () => parseNodeResult(`\`\`\`json
{
  "status": "success",
  "summary": "done",
  "document": "",
  "artifacts": [],
  "feedback": { "defects": [], "change_requests": [] },
  "questions": [],
  "handoff_to": { "instruction": "next", "must_follow": [], "known_risks": [], "open_questions": [] }
}
\`\`\``),
      /artifacts|handoff_to|deliverables|handoff/
    );
  });

  it("rejects needs_user_input without a concrete question", () => {
    assert.throws(
      () => parseNodeResult(JSON.stringify({
        status: "needs_user_input",
        summary: "need input",
        document: "",
        deliverables: [],
        feedback: { defects: [], change_requests: [] },
        questions: [],
        handoff: { instruction: "", must_follow: [], known_risks: [], open_questions: [] }
      })),
      /needs_user_input results must include at least one concrete question/i
    );
  });

  it("rejects responses that contain multiple NodeResult objects", () => {
    const first = JSON.stringify({ status: "failure", summary: "first", document: "", deliverables: [], feedback: { defects: ["bad"], change_requests: [] }, questions: [], handoff: { instruction: "retry", must_follow: [], known_risks: [], open_questions: [] } });
    const second = JSON.stringify({ status: "success", summary: "second", document: "", deliverables: [], feedback: { defects: [], change_requests: [] }, questions: [], handoff: { instruction: "done", must_follow: [], known_risks: [], open_questions: [] } });

    assert.throws(() => parseNodeResult(`${first}${second}`), /multiple NodeResult/i);
  });
});
