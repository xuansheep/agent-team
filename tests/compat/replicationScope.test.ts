import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("tui-code replication scope", () => {
  it("documents required modules and excluded capabilities", async () => {
    const scope = await readFile(resolve("docs/tui-code-replication-scope.md"), "utf8");
    const requiredTerms = [
      "QueryEngine",
      "Tool",
      "PermissionMode",
      "Plan Mode",
      "Session Storage",
      "MCP",
      "Tasks",
      "SDK/headless",
      "TUI logging excluded",
      "Remote excluded"
    ];

    for (const term of requiredTerms) {
      assert.match(scope, new RegExp(escapeRegExp(term)), `missing scope term: ${term}`);
    }
  });

  it("keeps remote, telemetry, and TUI logging out of the replication target", async () => {
    const scope = await readFile(resolve("docs/tui-code-replication-scope.md"), "utf8");

    assert.match(scope, /Do not replicate the TUI logging system\./);
    assert.match(scope, /Do not enable outbound telemetry by default\./);
    assert.match(scope, /Do not implement remote capabilities\./);
    assert.match(scope, /Do not create remote transport\./);
    assert.match(scope, /Do not implement remote resume\./);
    assert.match(scope, /Workflow node `mode: "plan"` is removed from the supported model\./);
    assert.match(scope, /workflow nodes must reject both `mode: "plan"` and `permission_mode: "plan"` configuration\./);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
