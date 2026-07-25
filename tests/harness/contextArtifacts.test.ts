import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/storage/artifacts.js";
import { buildNodeMessages } from "../../src/harness/context.js";
import type { WorkflowNodeConfig } from "../../src/config/schema.js";

describe("artifact handoff reads", () => {
  it("reads UTF-8 text in byte-safe pages", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-read-"));
    const store = new ArtifactStore(runDir);
    const ref = await store.writeText("product", "brief.md", "甲乙丙丁");
    const first = await store.readText(ref.artifactId, { maxBytes: 4 });
    const second = await store.readText(ref.artifactId, { offset: first.next_offset, maxBytes: 8 });

    assert.equal(first.content, "甲");
    assert.equal(first.truncated, true);
    assert.equal(second.content, "乙丙");
    assert.equal(second.offset, first.next_offset);
  });

  it("rejects tampered artifact content", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-integrity-"));
    const store = new ArtifactStore(runDir);
    const ref = await store.writeText("product", "brief.md", "trusted");
    await writeFile(ref.path, "tampered", "utf8");

    await assert.rejects(() => store.readText(ref.artifactId), /integrity check failed/);
  });

  it("injects referenced artifacts into the downstream node context", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-context-"));
    const store = new ArtifactStore(runDir);
    const ref = await store.writeText("product", "brief.md", "upstream content");
    const reads: string[] = [];
    const messages = await buildNodeMessages(
      { id: "review", role: "review", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Review.",
      { references: [{ artifact_ids: [ref.artifactId] }] },
      { runDir, onArtifactRead: (chunk) => { reads.push(chunk.artifact_id); } }
    );
    const user = messages.find((message) => message.role === "user");

    assert.match(String(user?.content), /upstream content/);
    assert.deepEqual(reads, [ref.artifactId]);
  });
  it("injects referenced images for vision providers and metadata for non-vision providers", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-image-"));
    const imagePath = join(runDir, "diagram.png");
    const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]);
    await writeFile(imagePath, imageBytes);
    const store = new ArtifactStore(runDir);
    const ref = await store.importFile("developer", imagePath, "diagram.png", { description: "UI screenshot" });

    const visionMessages = await buildNodeMessages(
      { id: "tester", role: "tester", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Test.",
      { references: [{ artifact_ids: [ref.artifactId] }] },
      { runDir, supportsVision: true }
    );
    const visionUser = visionMessages.find((message) => message.role === "user");
    assert.ok(Array.isArray(visionUser?.content));
    const visionParts = visionUser?.content as Array<{ type: string; text?: string; data?: string }>;
    assert.equal(visionParts.find((part) => part.type === "image")?.data, imageBytes.toString("base64"));
    assert.match(visionParts.find((part) => part.type === "text")?.text ?? "", /"kind": "image"/);

    const textOnlyMessages = await buildNodeMessages(
      { id: "tester", role: "tester", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Test.",
      { references: [{ artifact_ids: [ref.artifactId] }] },
      { runDir, supportsVision: false }
    );
    const textOnlyUser = textOnlyMessages.find((message) => message.role === "user");
    assert.equal(typeof textOnlyUser?.content, "string");
    assert.match(String(textOnlyUser?.content), /provider does not support vision/);

    const index = JSON.parse(await readFile(join(runDir, "artifacts", "index.json"), "utf8")) as { artifacts: Array<{ kind?: string; media_type?: string }> };
    assert.equal(index.artifacts[0]?.kind, "image");
    assert.equal(index.artifacts[0]?.media_type, "image/png");
  });

  it("recovers legacy untyped PNG artifacts without decoding them as UTF-8", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-legacy-image-"));
    const imagePath = join(runDir, "legacy.png");
    await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff]));
    const store = new ArtifactStore(runDir);
    const ref = await store.importFile("developer", imagePath);
    const indexPath = join(runDir, "artifacts", "index.json");
    const index = JSON.parse(await readFile(indexPath, "utf8")) as { version: 1; artifacts: Array<Record<string, unknown>> };
    delete index.artifacts[0]?.kind;
    delete index.artifacts[0]?.media_type;
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf8");

    const messages = await buildNodeMessages(
      { id: "tester", role: "tester", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Test.",
      { references: [{ artifact_ids: [ref.artifactId] }] },
      { runDir, supportsVision: false }
    );

    assert.match(String(messages.find((message) => message.role === "user")?.content), /"kind": "image"/);
  });

  it("describes unknown binary artifacts instead of treating them as text", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "agent-team-artifact-binary-"));
    const binaryPath = join(runDir, "payload.bin");
    await writeFile(binaryPath, Buffer.from([0xff, 0xfe, 0xfd]));
    const ref = await new ArtifactStore(runDir).importFile("developer", binaryPath);
    const messages = await buildNodeMessages(
      { id: "tester", role: "tester", provider: "default", permission_mode: "default" } as WorkflowNodeConfig,
      "Test.",
      { references: [{ artifact_ids: [ref.artifactId] }] },
      { runDir, supportsVision: true }
    );

    const content = messages.find((message) => message.role === "user")?.content;
    assert.equal(typeof content, "string");
    assert.match(String(content), /"kind": "binary"/);
    assert.match(String(content), /Binary content is not injected/);
  });

});
