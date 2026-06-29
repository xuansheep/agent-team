import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isDestructiveGitCommand } from "../../src/security/gitSafety.js";
import { isDestructiveShellCommand, isReadOnlyShellCommand } from "../../src/security/shellSafety.js";

function destructive(command: string): boolean {
  return isDestructiveShellCommand({ command });
}

function readOnly(command: string): boolean {
  return isReadOnlyShellCommand({ command });
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

  it("allows only conservative read-only shell commands", () => {
    assert.equal(readOnly("pwd"), true);
    assert.equal(readOnly("ls -la"), true);
    assert.equal(readOnly('rg "Plan Mode" src'), true);
    assert.equal(readOnly("git status --short"), true);
    assert.equal(readOnly("git diff -- src/index.ts"), true);
    assert.equal(readOnly("npm test"), false);
    assert.equal(readOnly("cat package.json > copy.json"), false);
    assert.equal(readOnly("pwd && npm test"), false);
    assert.equal(readOnly("echo $(rm -rf dist)"), false);
    assert.equal(readOnly("find . -delete"), false);
  });

  it("allows conservative compound read-only shell exploration like tui-code", () => {
    assert.equal(readOnly("pwd && ls -la"), true);
    assert.equal(readOnly("git status --short; git diff -- src/index.ts"), true);
    assert.equal(readOnly('rg "Plan Mode" src | head -20'), true);
    assert.equal(readOnly("cd /tmp && git status --short"), false);
    assert.equal(readOnly("rg foo src | tee out.txt"), false);
    assert.equal(readOnly("pwd && npm test"), false);
    assert.equal(readOnly("pwd && rm -rf dist"), false);
    assert.equal(readOnly("cat package.json < input.txt"), false);
  });
});
