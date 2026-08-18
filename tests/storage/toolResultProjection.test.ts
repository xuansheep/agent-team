import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolResultProjection,
  ToolResultProjectionStore
} from "../../src/storage/toolResultProjection.js";

describe("tool result projection storage", () => {
  it("creates a deterministic projection and canonical content hash", () => {
    const left = createToolResultProjection("call-1", {
      z: "TAIL",
      a: `HEAD-${"x".repeat(3_000)}`
    });
    const right = createToolResultProjection("call-1", {
      a: `HEAD-${"x".repeat(3_000)}`,
      z: "TAIL"
    });

    assert.equal(left.content_sha256, right.content_sha256);
    assert.equal(left.projected_content, right.projected_content);
    assert.equal(left.projection_sha256, right.projection_sha256);
    assert.equal(left.projected, true);
    assert.match(left.projected_content, /HEAD-/);
    assert.match(left.projected_content, /TAIL/);
    assert.match(left.reference_description, /^tool_call_id="call-1" content_sha256=[a-f0-9]{64}$/);
  });

  it("persists full content as an artifact and replays the exact projection", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-tool-projection-"));
    const store = new ToolResultProjectionStore(runDir);
    const value = `HEAD-${"中".repeat(2_000)}-TAIL`;

    const first = await store.persist("call-2", value, { nodeId: "developer", attempt: 2, activation: 3 });
    const second = await store.persist("call-2", value, { nodeId: "developer", attempt: 2, activation: 3 });
    const replayed = await store.replay("call-2", first.content_sha256);

    assert.equal(first.artifact_id, second.artifact_id);
    assert.equal(replayed, first.projected_content);
    assert.equal(await store.replay("call-2", "0".repeat(64)), undefined);
    assert.ok(first.artifact_id);

    const index = JSON.parse(await readFile(join(runDir, "tool-result-projections", "index.json"), "utf8")) as {
      records: unknown[];
    };
    assert.equal(index.records.length, 1);
  });

  it("rejects a tampered projected replay", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-tool-projection-integrity-"));
    const store = new ToolResultProjectionStore(runDir);
    const record = await store.persist("call-3", "x".repeat(4_000));
    const indexPath = join(runDir, "tool-result-projections", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as {
      records: Array<{ projected_content: string }>;
    };
    index.records[0]!.projected_content += "tampered";
    await writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");

    await assert.rejects(
      () => store.replay("call-3", record.content_sha256),
      /projection integrity check failed/
    );
  });
});
