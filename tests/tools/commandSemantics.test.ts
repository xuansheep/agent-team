import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { interpretBashCommand, interpretPowerShellCommand } from "../../src/tools/local/commandSemantics.js";
import { encodePowerShellCommand } from "../../src/tools/local/shellProvider.js";

describe("shell command semantics", () => {
  it("treats search no-match exit codes as informational", () => {
    assert.equal(interpretBashCommand("rg missing src", 1, "", "").isError, false);
    assert.equal(interpretPowerShellCommand("findstr missing file.txt", 1, "", "").isError, false);
  });

  it("keeps ordinary non-zero exits as failures", () => {
    assert.equal(interpretBashCommand("node script.js", 1, "", "failed").isError, true);
    assert.equal(interpretPowerShellCommand("node script.js", 1, "", "failed").isError, true);
  });

  it("preserves Windows path characters through EncodedCommand", () => {
    const command = "Get-Content -LiteralPath 'C:\\\\work\\\\目录\\\\a b&c.txt'";
    const decoded = Buffer.from(encodePowerShellCommand(command), "base64").toString("utf16le");

    assert.match(decoded, /C:\\\\work\\\\目录\\\\a b&c\.txt/);
  });

  it("honors robocopy success bitmask codes", () => {
    assert.equal(interpretPowerShellCommand("robocopy src dst", 7, "", "").isError, false);
    assert.equal(interpretPowerShellCommand("robocopy src dst", 8, "", "").isError, true);
  });
});
