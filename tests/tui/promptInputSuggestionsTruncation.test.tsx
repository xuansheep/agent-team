import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { render } from "ink-testing-library";
import { PromptInputSuggestions } from "../../src/tui/components/PromptInput/PromptInputSuggestions.js";
import { stringWidth } from "../../src/ink/stringWidth.js";

describe("PromptInputSuggestions description layout", () => {
  it("keeps multiline descriptions on one line", () => {
    const suggestions = [{
      value: "/multiline",
      label: "/multiline",
      description: "first line\nsecond line",
      type: "command" as const
    }];
    const output = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={0} />);
    const frame = output.lastFrame() ?? "";

    assert.equal(frame.split("\n").length, 1);
    assert.match(frame, /first line second line/);
    output.unmount();
    output.cleanup();
  });

  it("truncates descriptions that exceed the available row width", () => {
    const suggestions = [{
      value: "/long",
      label: "/long",
      description: "description ".repeat(20),
      type: "command" as const
    }];
    const output = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={0} />);
    const frame = output.lastFrame() ?? "";

    assert.equal(frame.split("\n").length, 1);
    assert.match(frame, /…/);
    output.unmount();
    output.cleanup();
  });

  it("aligns command and skill descriptions by display width", () => {
    const suggestions = [
      { value: "/new", label: "/new", description: "command detail", type: "command" as const },
      { value: "/数据-skill", label: "/数据-skill", description: "skill detail", type: "command" as const }
    ];
    const output = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={0} />);
    const lines = (output.lastFrame() ?? "").split("\n");
    const commandLine = lines.find((line) => line.includes("command detail"));
    const skillLine = lines.find((line) => line.includes("skill detail"));

    assert.ok(commandLine);
    assert.ok(skillLine);
    assert.equal(
      stringWidth(commandLine.slice(0, commandLine.indexOf("command detail"))),
      stringWidth(skillLine.slice(0, skillLine.indexOf("skill detail")))
    );
    output.unmount();
    output.cleanup();
  });

  it("keeps the shared description column stable while scrolling", () => {
    const labels = ["/one", "/two", "/three", "/four", "/five", "/six", "/seven", "/exceptionally-long-skill-name"];
    const suggestions = labels.map((label) => ({
      value: label,
      label,
      description: `${label.slice(1)} detail`,
      type: "command" as const
    }));
    const initial = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={0} />);
    const scrolled = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={6} />);
    const initialLine = (initial.lastFrame() ?? "").split("\n").find((line) => line.includes("three detail"));
    const scrolledLine = (scrolled.lastFrame() ?? "").split("\n").find((line) => line.includes("three detail"));

    assert.ok(initialLine);
    assert.ok(scrolledLine);
    assert.equal(
      stringWidth(initialLine.slice(0, initialLine.indexOf("three detail"))),
      stringWidth(scrolledLine.slice(0, scrolledLine.indexOf("three detail")))
    );
    initial.unmount();
    initial.cleanup();
    scrolled.unmount();
    scrolled.cleanup();
  });

  it("caps an overlong skill label so its description remains visible", () => {
    const suggestions = [{
      value: "/overlong",
      label: `/${"skill".repeat(30)}`,
      description: "skill detail",
      type: "command" as const
    }];
    const output = render(<PromptInputSuggestions suggestions={suggestions} selectedIndex={0} />);
    const frame = output.lastFrame() ?? "";

    assert.equal(frame.split("\n").length, 1);
    assert.match(frame, /…  skill detail/);
    output.unmount();
    output.cleanup();
  });
});
