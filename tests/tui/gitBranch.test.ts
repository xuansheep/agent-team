import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { currentGitBranch } from "../../src/tui/gitBranch.js";

describe("currentGitBranch", () => {
  it("runs git in the requested directory and trims the branch name", async () => {
    const branch = await currentGitBranch("D:/repo", async (file, args, options) => {
      assert.equal(file, "git");
      assert.deepEqual(args, ["branch", "--show-current"]);
      assert.ok(options);
      assert.equal(options.cwd, "D:/repo");
      assert.equal(options.timeout, 3_000);
      return { code: 0, stdout: "feature/statusline\n", stderr: "" };
    });

    assert.equal(branch, "feature/statusline");
  });

  it("omits failed and empty branch lookups", async () => {
    assert.equal(
      await currentGitBranch("D:/repo", async () => ({ code: 1, stdout: "", stderr: "not a git repository" })),
      undefined
    );
    assert.equal(
      await currentGitBranch("D:/repo", async () => ({ code: 0, stdout: "\n", stderr: "" })),
      undefined
    );
  });
});
