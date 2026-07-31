import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCompactToolResultDetail, getToolResultDetail, sanitizeToolLogText } from "../../src/tui/toolDisplay.js";

describe("toolDisplay", () => {
  it("strips ANSI control sequences from tool log text", () => {
    const text = `before\u001b[31mred\u001b[0mafter\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007`;

    assert.equal(sanitizeToolLogText(text), "beforeredafterlink");
  });

  it("keeps full command output in detailed tool results", () => {
    const output = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");

    const detail = getToolResultDetail({ output, exit_code: 0 });

    assert.match(detail, /^line-1/);
    assert.match(detail, /line-3/);
    assert.match(detail, /line-6/);
    assert.match(detail, /line-9/);
    assert.match(detail, /line-10$/);
    assert.doesNotMatch(detail, /ctrl \+ o to view transcript/);
    assert.doesNotMatch(detail, /Exit code:/);
  });

  it("summarizes compact command output with a transcript hint", () => {
    const output = Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\n");

    const detail = getCompactToolResultDetail({ output, exit_code: 0 });

    assert.match(detail, /^line-1/);
    assert.match(detail, /line-2/);
    assert.match(detail, /… \+6 lines \(ctrl \+ o to view transcript\)/);
    assert.match(detail, /line-9/);
    assert.match(detail, /line-10$/);
    assert.doesNotMatch(detail, /line-3/);
    assert.doesNotMatch(detail, /line-6/);
    assert.doesNotMatch(detail, /Exit code:/);
  });

  it("shows short successful output in compact mode", () => {
    assert.equal(getCompactToolResultDetail({ output: "ok", exit_code: 0 }), "ok");
  });

  it("shows empty command output explicitly", () => {
    const detail = getToolResultDetail({ output: "", exit_code: 0 });

    assert.equal(detail, "(no output)");
  });

  it("uses English error and non-zero exit-code labels", () => {
    const detail = getToolResultDetail({ output: "failed", stderr: "stderr text", error: "boom", exit_code: 7 });

    assert.equal(detail, "failed\nstderr text\nError: boom\nExit code: 7");
  });
});
