import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PermissionController } from "../../src/harness/permissionController.js";

describe("PermissionController", () => {
  it("waits until a request is resolved", async () => {
    const controller = new PermissionController();
    const waiting = controller.request({
      requestId: "perm-1",
      nodeId: "dev",
      attempt: 1,
      toolCallId: "tool-1",
      tool: "Bash",
      input: { command: "npm test" },
      specifier: "npm test",
      rule: "Bash(npm test)"
    });

    controller.resolve("perm-1", "allow_once");

    assert.equal(await waiting, "allow_once");
  });

  it("rejects unknown request ids", () => {
    const controller = new PermissionController();
    assert.throws(() => controller.resolve("missing", "deny_once"), /Unknown permission request missing/);
  });
});
