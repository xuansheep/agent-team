import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getToolResultDetail } from "../../src/tui/toolDisplay.js";

describe("toolDisplay", () => {
  it("summarizes long command output with a Codex-style transcript hint", () => {
    const output = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");

    const detail = getToolResultDetail({ output, exit_code: 0 });

    assert.match(detail, /输出：line-1/);
    assert.match(detail, /line-2/);
    assert.match(detail, /… \+6 lines \(ctrl \+ t to view transcript\)/);
    assert.match(detail, /line-9/);
    assert.match(detail, /line-10/);
    assert.doesNotMatch(detail, /line-3/);
    assert.doesNotMatch(detail, /line-6/);
    assert.match(detail, /退出码：0/);
  });

  it("shows empty command output explicitly", () => {
    const detail = getToolResultDetail({ output: "", exit_code: 0 });

    assert.match(detail, /输出：\(no output\)/);
    assert.match(detail, /退出码：0/);
  });
});
