import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSkillMarkdown } from "../../src/skills/skillLoader.js";
import { HookRuntime, registerSkillHooks } from "../../src/hooks/runtime.js";

describe("skill hooks", () => {
  it("parses hooks from skill frontmatter", () => {
    const skill = parseSkillMarkdown(`---
name: reviewer
hooks:
  Stop:
    - matcher: ""
      hooks:
        - type: command
          command: echo ok
---
Review before stopping.
`);

    assert.equal(skill.hooks?.Stop?.[0]?.hooks[0]?.type, "command");
  });

  it("registers skill hooks into the global hook runtime", async () => {
    const runtime = new HookRuntime(undefined, {
      commandExecutor: () => ({
        stdout: JSON.stringify({ continue: false, stopReason: "skill blocked" }),
        stderr: "",
        exitCode: 0
      })
    });
    const ids = registerSkillHooks(runtime, {
      Stop: [{
        hooks: [{
          type: "command",
          command: "skill-stop"
        }]
      }]
    }, "reviewer");

    const result = await runtime.run("Stop", {}, {
      cwd: process.cwd(),
      sessionId: "session-1"
    });

    assert.equal(ids.length, 1);
    assert.equal(result.stopReason, "skill blocked");
  });
});
