import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPlanModeAttachment, hasRuntimeAttachment } from "../../src/context/attachments.js";
import { buildNodeMessages } from "../../src/harness/context.js";
import { RuntimeTurnExecutor } from "../../src/runtime/turnExecutor.js";
import { ModelProvider } from "../../src/providers/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "agent-team-context-"));
}

describe("runtime context attachments", () => {
  it("injects full Plan Mode instructions and the current draft on the first planning turn", async () => {
    const cwd = await workspace();
    const planFilePath = join(cwd, ".session", "plans", "session-1.md");
    await mkdir(join(cwd, ".session", "plans"), { recursive: true });
    await writeFile(planFilePath, "# Draft\n\nRead first.\n", "utf8");
    let systemContent = "";
    const provider: ModelProvider = {
      async generate(request) {
        systemContent = String(request.messages.find((message) => message.role === "system")?.content ?? "");
        return { content: "planning" };
      }
    };

    const result = await new RuntimeTurnExecutor().execute({
      messages: [{ role: "user", content: "make a plan" }],
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath },
      cwd,
      sessionId: "session-1"
    });

    assert.equal(result.status, "completed");
    assert.match(systemContent, /ATTACHMENT plan_mode/);
    assert.match(systemContent, /do not start workflow execution/i);
    assert.match(systemContent, /current plan file/i);
    assert.match(systemContent, /# Draft/);
  });

  it("injects only a sparse Plan Mode reminder after the full attachment already exists", async () => {
    const attachment = buildPlanModeAttachment({ sessionId: "session-1", planFilePath: ".session/plans/session-1.md", draft: "# Draft", sparse: false });
    const priorMessages = [
      { role: "system" as const, content: attachment.content },
      { role: "user" as const, content: "make a plan" },
      { role: "assistant" as const, content: "drafted" },
      { role: "user" as const, content: "revise it" }
    ];
    let systemMessages: string[] = [];
    const provider: ModelProvider = {
      async generate(request) {
        systemMessages = request.messages.filter((message) => message.role === "system").map((message) => String(message.content));
        return { content: "revised" };
      }
    };

    await new RuntimeTurnExecutor().execute({
      messages: priorMessages,
      model: "test-model",
      provider,
      tools: new ToolRegistry(),
      permissions: { mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/session-1.md" },
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode").length, 1);
    assert.equal(systemMessages.filter((content) => content.split("\n")[0] === "ATTACHMENT plan_mode_reminder").length, 1);
    assert.ok(systemMessages.some((content) => /continue planning only/i.test(content)));
  });

  it("injects a plan mode exit attachment once for approved plan workflow handoff", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it." }
    );

    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const secondPass = await buildNodeMessages(
      { id: "next", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { previous_handoff: { instruction: "continue" } }
    );
    const secondSystem = String(secondPass.find((message) => message.role === "system")?.content ?? "");

    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.match(system, /approved plan/);
    assert.match(system, /# Plan/);
    assert.doesNotMatch(secondSystem, /ATTACHMENT plan_mode_exit/);
  });

  it("keeps approved plan and original input in the workflow handoff payload", async () => {
    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      { original_input: { request: "build" }, approved_plan: "# Plan\nBuild it." }
    );
    const user = messages.find((message) => message.role === "user");

    assert.match(String(user?.content), /approved_plan/);
    assert.match(String(user?.content), /original_input/);
    assert.equal(hasRuntimeAttachment(messages, "plan_mode_exit"), true);
  });

  it("preserves workflow handoff, images, pending review, and approved plan context together", async () => {
    const cwd = await workspace();
    const imagePath = join(cwd, "input.png");
    await writeFile(imagePath, Buffer.from([137, 80, 78, 71]));

    const messages = await buildNodeMessages(
      { id: "dev", role: "developer", provider: "default", permission_mode: "default" },
      "System prompt",
      {
        original_input: { request: "build" },
        approved_plan: "# Plan\nBuild it.",
        pending_review: { node_id: "product", document: "# Review Plan" },
        images: [{ artifact_id: "img-1", path: imagePath, media_type: "image/png" }]
      }
    );
    const system = String(messages.find((message) => message.role === "system")?.content ?? "");
    const user = messages.find((message) => message.role === "user");

    assert.match(system, /ATTACHMENT plan_mode_exit/);
    assert.ok(Array.isArray(user?.content));
    const parts = user?.content as Array<{ type: string; text?: string; media_type?: string }>;
    assert.match(String(parts.find((part) => part.type === "text")?.text), /pending_review/);
    assert.equal(parts.find((part) => part.type === "image")?.media_type, "image/png");
  });

});
