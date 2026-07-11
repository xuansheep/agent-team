import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { SlashCommandSuggestion } from "../../src/tui/commandCompletion.js";
import { PromptInputSuggestions } from "../../src/tui/components/PromptInput/PromptInputSuggestions.js";

const suggestions: SlashCommandSuggestion[] = [
  "one", "two", "three", "four", "five", "six", "seven", "eight"
].map((name) => ({
  value: `/${name}`,
  label: `/${name}`,
  description: `${name} command`,
  type: "command"
}));

describe("PromptInputSuggestions", () => {
  it("shows the first six suggestions at the start", () => {
    const output = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={0} />);
    const frame = output.lastFrame() ?? "";

    assert.match(frame, /> \/one/);
    assert.match(frame, /\/six/);
    assert.doesNotMatch(frame, /\/seven|\/eight/);
    output.unmount();
    output.cleanup();
  });

  it("scrolls the visible window to keep a later selection highlighted", () => {
    const output = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={6} />);
    const frame = output.lastFrame() ?? "";

    assert.doesNotMatch(frame, /\/one|\/two/);
    assert.match(frame, /\/three/);
    assert.match(frame, /> \/seven/);
    assert.match(frame, /\/eight/);
    output.unmount();
    output.cleanup();
  });
});
