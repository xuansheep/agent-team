import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createKernelSession } from "../../src/kernel/session.js";
import { QueryEngine } from "../../src/kernel/queryEngine.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ModelProvider } from "../../src/providers/types.js";

function providerWithToolCalls(tool_calls: { id: string; name: string; input: unknown }[]): ModelProvider {
  return { generate: async () => ({ content: "", tool_calls }), stream: undefined } as unknown as ModelProvider;
}

describe("QueryEngine", () => {
  it("turns user interaction tools into pending interactions", async () => {
    const legacy = new ToolRegistry();
    legacy.add({
      name: "AskUserQuestion",
      description: "ask",
      input_schema: {},
      requiresUserInteraction: async () => true,
      execute: async () => ({ data: { type: "user_input_requested", questions: [{ question: "Pick?" }] } })
    });
    const session = createKernelSession({ id: "s1", cwd: process.cwd(), permissions: { mode: "plan", allow: [], ask: [], deny: [] } });

    const result = await new QueryEngine().run({
      session,
      provider: providerWithToolCalls([{ id: "call-1", name: "AskUserQuestion", input: { questions: [{ question: "Pick?" }] } }]),
      model: "test-model",
      tools: createKernelToolRegistry(legacy)
    });

    assert.equal(result.session.status, "waiting_user_input");
    assert.equal(result.session.pendingInteraction?.type, "ask_user_question");
  });
});
