import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLocalToolRegistry } from "../../src/tools/registry.js";
import { adaptToolToKernelTool } from "../../src/kernel/tools/protocol.js";
import { createKernelToolRegistry } from "../../src/kernel/tools/registry.js";

describe("Kernel tool protocol", () => {
  it("adapts existing tools and keeps plan write tools visible", async () => {
    const read = adaptToolToKernelTool(createLocalToolRegistry().get("Read"));
    assert.equal(read.name, "Read");
    assert.equal(await read.isReadOnly({ file_path: "package.json" }, { cwd: process.cwd() }), true);

    const names = createKernelToolRegistry(createLocalToolRegistry())
      .visibleTools({ mode: "plan", allow: [], ask: [], deny: [], planFilePath: ".session/plans/s1.md" })
      .map((tool) => tool.name);
    assert.equal(names.includes("Write"), true);
    assert.equal(names.includes("Edit"), true);
    assert.equal(names.includes("MultiEdit"), true);
    assert.equal(names.includes("ExitPlanMode"), true);
  });
});
