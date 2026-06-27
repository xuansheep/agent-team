import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDestructiveGitCommand } from "../../src/security/gitSafety.js";
import { isDestructiveShellCommand } from "../../src/security/shellSafety.js";

function destructive(command: string): boolean {
  return isDestructiveShellCommand({ command });
}

describe("shell and git safety", () => {
  it("classifies deletion file writes and destructive git commands", () => {
    assert.equal(destructive("rm -rf dist"), true);
    assert.equal(destructive("Remove-Item out.txt"), true);
    assert.equal(destructive("echo hi > out.txt"), true);
    assert.equal(destructive("git reset --hard"), true);
    assert.equal(destructive("git checkout -- src/index.ts"), true);
  });

  it("does not classify ordinary read-only commands as destructive", () => {
    assert.equal(destructive("npm test"), false);
    assert.equal(destructive('rg ">" src'), false);
    assert.equal(destructive("git status --short"), false);
  });

  it("recognizes destructive git operations directly", () => {
    assert.equal(isDestructiveGitCommand("git clean -xfd"), true);
    assert.equal(isDestructiveGitCommand("git restore src/index.ts"), true);
    assert.equal(isDestructiveGitCommand("git status"), false);
  });
});
