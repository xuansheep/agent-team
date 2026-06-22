import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalToolRegistry } from "../../src/tools/registry.js";

async function workspace() {
  return mkdtemp(join(tmpdir(), "agent-team-tools-"));
}

describe("local tools", () => {
  it("reads, writes, and edits files", async () => {
    const cwd = await workspace();
    const tools = createLocalToolRegistry();

    await tools.get("Write").execute({ file_path: "a.txt", content: "hello" }, { cwd });
    await tools.get("Edit").execute({ file_path: "a.txt", old_string: "hello", new_string: "world" }, { cwd });
    const result = await tools.get("Read").execute({ file_path: "a.txt" }, { cwd });

    assert.match(result.output ?? "", /world/);
  });

  it("registers command tools", () => {
    const tools = createLocalToolRegistry();

    assert.equal(tools.get("Bash").name, "Bash");
    assert.equal(tools.get("PowerShell").name, "PowerShell");
  });
});
