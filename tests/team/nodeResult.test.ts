import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nodeResultJsonSchema, nodeResultOutputInstructions, parseNodeResult, visibleAssistantTextBeforeNodeResult } from "../../src/team/nodeResult.js";

describe("nodeResultJsonSchema", () => {
  it("requires every top-level property for strict structured output", () => {
    const properties = Object.keys(nodeResultJsonSchema.properties).sort();
    const required = [...nodeResultJsonSchema.required].sort();

    assert.deepEqual(required, properties);
  });

  it("defaults document to an empty string when omitted", () => {
    const result = parseNodeResult(JSON.stringify({ direction: "forward", summary: "done" }));

    assert.equal(result.document, "");
  });

  it("extracts a fenced JSON NodeResult from provider prose", () => {
    const result = parseNodeResult(`The task is done.

\`\`\`json
{
  "direction": "forward",
  "summary": "done",
  "document": "",
  "deliverables": [],
  "feedback": { "defects": [], "change_requests": [] },
  "questions": [],
  "handoff": { "instruction": "next", "must_follow": [], "known_risks": [], "open_questions": [] }
}
\`\`\``);

    assert.equal(result.direction, "forward");
    assert.equal(result.handoff.instruction, "next");
  });

  it("rejects extracted JSON with non-NodeResult fields", () => {
    assert.throws(
      () => parseNodeResult(`\`\`\`json
{
  "direction": "forward",
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

  it("rejects the legacy status protocol", () => {
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
      /direction|status/i
    );
  });

  it("instructs models to write Codex-style user-visible preambles before tools", () => {
    assert.match(nodeResultOutputInstructions, /same language as the user/i);
    assert.match(nodeResultOutputInstructions, /Do not begin writing NodeResult keys before tool calls/i);
  });

  it("hides structured JSON fragments from visible assistant preambles", () => {
    assert.equal(visibleAssistantTextBeforeNodeResult('{"deliver'), "");
    assert.equal(visibleAssistantTextBeforeNodeResult('{"foo":"bar"'), "");
    assert.equal(visibleAssistantTextBeforeNodeResult('[{"id":"next_step"'), "");
    assert.equal(visibleAssistantTextBeforeNodeResult('```json\n{"direction":"forward"'), "");
    assert.equal(visibleAssistantTextBeforeNodeResult('我先检查项目结构。\n{"direction":"forward"}'), "我先检查项目结构。");
  });

  it("rejects responses that contain multiple NodeResult objects", () => {
    const first = JSON.stringify({ direction: "backward", summary: "first", document: "", deliverables: [], feedback: { defects: ["bad"], change_requests: [] }, questions: [], handoff: { instruction: "retry", must_follow: [], known_risks: [], open_questions: [] } });
    const second = JSON.stringify({ direction: "forward", summary: "second", document: "", deliverables: [], feedback: { defects: [], change_requests: [] }, questions: [], handoff: { instruction: "done", must_follow: [], known_risks: [], open_questions: [] } });

    assert.throws(() => parseNodeResult(`${first}${second}`), /multiple NodeResult/i);
  });
});
