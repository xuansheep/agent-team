import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelToolResultContent, persistedToolResultMessage, truncateModelVisibleText } from "../../src/tools/modelResult.js";

describe("model-visible tool result limits", () => {
  it("preserves both ends with the legacy middle-truncation helper", () => {
    const value = `HEAD-${"中".repeat(200)}-TAIL`;
    const truncated = truncateModelVisibleText(value, 160);

    assert.match(truncated, /^HEAD-/);
    assert.match(truncated, /-TAIL$/);
    assert.match(truncated, /chars truncated/);
    assert.equal(truncated.includes("�"), false);
  });

  it("projects results over 2 KiB with stable head, tail, sha256, and reference", () => {
    const value = `HEAD-${"中".repeat(1200)}-TAIL`;
    const first = modelToolResultContent(value, { toolCallId: "call-1" });
    const second = modelToolResultContent(value, { toolCallId: "call-1" });
    if (typeof first !== "string" || typeof second !== "string") {
      throw new Error("Expected string tool result projections");
    }

    assert.equal(first, second);
    assert.match(first, /^HEAD-/);
    assert.match(first, /-TAIL$/);
    assert.match(first, /sha256=[a-f0-9]{64}/);
    assert.match(first, /tool_call_id="call-1"/);
    assert.match(first, /content_sha256=[a-f0-9]{64}/);
    assert.equal(first.includes("�"), false);
    assert.ok(Buffer.byteLength(first, "utf8") <= 2 * 1024);
  });

  it("applies one shared text budget across multipart tool output", () => {
    const content = modelToolResultContent([
      { type: "text", text: "a".repeat(3_000) },
      { type: "text", text: "b".repeat(3_000) },
      { type: "tool_reference", tool_name: "Search" }
    ], { byteLimit: 1_024, toolCallId: "call-2" });

    assert.ok(Array.isArray(content));
    const text = content.filter((part) => part.type === "text").map((part) => part.text).join("");
    assert.ok(Buffer.byteLength(text, "utf8") <= 1_024);
    assert.match(text, /sha256=/);
    assert.equal(text.includes("b".repeat(100)), false);
    assert.equal(content.some((part) => part.type === "tool_reference"), true);
  });

  it("caps one tool result at 10K approximate tokens", () => {
    const projected = modelToolResultContent("x".repeat(100_000), {
      toolCallId: "call-hard-cap",
      tokenLimit: 20_000
    });
    if (typeof projected !== "string") {
      throw new Error("Expected a string tool result projection");
    }

    assert.ok(Buffer.byteLength(projected, "utf8") <= 10_000 * 4);
    assert.match(projected, /sha256=/);
  });

  it("persists the exact model-visible projection in the active run directory", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-model-result-projection-"));
    const message = await persistedToolResultMessage(
      "call-persisted",
      { output: `HEAD-${"x".repeat(4_000)}-TAIL` },
      {
        name: "LargeResult",
        description: "Returns a large result",
        input_schema: {},
        async execute() {
          return { output: "unused" };
        }
      },
      { cwd: runDir, runDir, nodeId: "dev", attempt: 1 },
      { byteLimit: 1_024 }
    );
    const index = JSON.parse(
      await readFile(join(runDir, "tool-result-projections", "index.json"), "utf8")
    ) as { records: Array<{ tool_call_id: string; projected_content: string; artifact_id?: string }> };
    const record = index.records.find((item) => item.tool_call_id === "call-persisted");

    assert.ok(record);
    assert.equal(record.projected_content, message.content);
    assert.equal(typeof record.artifact_id, "string");
    assert.match(String(message.content), /Full result artifact_id=/);
  });

});
