import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { setupTerminal } from "../../src/tui/terminalSetup.js";

type Call = { file: string; args: string[] };

describe("terminal setup", () => {
  it("does not modify terminals with native enhanced key reporting", async () => {
    const calls: Call[] = [];
    const result = await setupTerminal({
      platform: "darwin",
      terminal: "iTerm.app",
      run: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(result.status, "not_needed");
    assert.deepEqual(calls, []);
  });

  it("backs up preferences and configures each Apple Terminal profile once", async () => {
    const calls: Call[] = [];
    const result = await setupTerminal({
      platform: "darwin",
      terminal: "Apple_Terminal",
      homeDir: "/fake-home",
      now: () => new Date("2026-08-02T00:00:00.000Z"),
      randomId: () => "fixed",
      makeDir: async () => undefined,
      run: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === "read") return { code: 0, stdout: "Basic\n", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.equal(result.status, "configured");
    assert.match(result.backupPath ?? "", /com[.]apple[.]Terminal[.]2026-08-02T00-00-00-000Z[.]fixed[.]plist$/);
    assert.equal(calls.filter((call) => call.file === "/usr/libexec/PlistBuddy").length, 1);
    assert.equal(calls[0]?.args[0], "export");
  });

  it("falls back from PlistBuddy Add to Set", async () => {
    const commands: string[] = [];
    await setupTerminal({
      platform: "darwin",
      terminal: "Apple_Terminal",
      homeDir: "/fake-home",
      makeDir: async () => undefined,
      run: async (file, args) => {
        if (args[0] === "read") return { code: 0, stdout: "Basic\n", stderr: "" };
        if (file === "/usr/libexec/PlistBuddy") {
          commands.push(args[1] ?? "");
          return { code: commands.length === 1 ? 1 : 0, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
    });

    assert.match(commands[0] ?? "", /^Add /);
    assert.match(commands[1] ?? "", /^Set /);
  });

  it("aborts before mutation when the backup fails", async () => {
    const calls: Call[] = [];
    await assert.rejects(() => setupTerminal({
      platform: "darwin",
      terminal: "Apple_Terminal",
      homeDir: "/fake-home",
      makeDir: async () => undefined,
      run: async (file, args) => {
        calls.push({ file, args });
        return { code: 1, stdout: "", stderr: "backup failed" };
      }
    }), /no settings were changed/);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.args[0], "export");
  });

  it("restores the backup when a profile update fails", async () => {
    const calls: Call[] = [];
    await assert.rejects(() => setupTerminal({
      platform: "darwin",
      terminal: "Apple_Terminal",
      homeDir: "/fake-home",
      makeDir: async () => undefined,
      run: async (file, args) => {
        calls.push({ file, args });
        if (args[0] === "read") {
          return { code: 0, stdout: args[2] === "Default Window Settings" ? "Basic\n" : "Pro\n", stderr: "" };
        }
        if (file === "/usr/libexec/PlistBuddy" && (args[1] ?? "").includes("Pro")) return { code: 1, stdout: "", stderr: "failed" };
        return { code: 0, stdout: "", stderr: "" };
      }
    }), /original preferences were restored/);

    assert.ok(calls.some((call) => call.args[0] === "import"));
  });

  it("reports the retained backup when automatic restore fails", async () => {
    await assert.rejects(() => setupTerminal({
      platform: "darwin",
      terminal: "Apple_Terminal",
      homeDir: "/fake-home",
      randomId: () => "restore-failed",
      makeDir: async () => undefined,
      run: async (file, args) => {
        if (args[0] === "read") return { code: 0, stdout: "Basic\n", stderr: "" };
        if (file === "/usr/libexec/PlistBuddy") return { code: 1, stdout: "", stderr: "failed" };
        if (args[0] === "import") return { code: 1, stdout: "", stderr: "restore failed" };
        return { code: 0, stdout: "", stderr: "" };
      }
    }), /defaults import com[.]apple[.]Terminal .*restore-failed/);
  });
});
