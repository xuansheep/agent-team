import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";


describe("Kernel tool protocol", () => {

  it("exposes write tools in plan mode while keeping EnterPlanMode hidden", () => {
    const registry = createKernelToolRegistry(createLocalToolRegistry());
    const visible = registry.visibleTools({ mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" }).map((tool) => tool.name);

    assert.equal(visible.includes("Write"), true);
    assert.equal(visible.includes("Edit"), true);
    assert.equal(visible.includes("MultiEdit"), true);
    assert.equal(visible.includes("LS"), true);
    assert.equal(visible.includes("List"), false);
    assert.equal(visible.includes("AskUserQuestion"), true);
    assert.equal(visible.includes("ExitPlanMode"), true);
    assert.equal(visible.includes("EnterPlanMode"), false);

    const write = registry.visibleTools({ mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" }).find((tool) => tool.name === "Write");
    const schema = write?.input_schema as { properties?: Record<string, unknown>; required?: string[] } | undefined;
    assert.ok(schema);
    assert.ok(schema.properties?.file_path);
    assert.deepEqual(schema.required, ["file_path", "content"]);
  });
});
