import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { env } from "../utils/env.js";
import { execFileNoThrow } from "../utils/execFileNoThrow.js";

export type TerminalSetupResult = {
  status: "configured" | "not_needed" | "unsupported";
  title: string;
  detail: string;
  backupPath?: string;
};

export type TerminalSetupOptions = {
  platform?: NodeJS.Platform;
  terminal?: string;
  homeDir?: string;
  now?: () => Date;
  randomId?: () => string;
  makeDir?: typeof mkdir;
  run?: typeof execFileNoThrow;
};

const nativeCsiUTerminals = new Map([
  ["ghostty", "Ghostty"],
  ["kitty", "Kitty"],
  ["iTerm.app", "iTerm2"],
  ["WezTerm", "WezTerm"],
  ["WarpTerminal", "Warp"]
]);

export async function setupTerminal(options: TerminalSetupOptions = {}): Promise<TerminalSetupResult> {
  const platform = options.platform ?? process.platform;
  const terminal = options.terminal ?? env.terminal;
  const nativeTerminal = terminal ? nativeCsiUTerminals.get(terminal) : undefined;

  if (nativeTerminal) {
    return {
      status: "not_needed",
      title: "Terminal setup not needed",
      detail: `${nativeTerminal} supports enhanced key reporting. Use Shift+Enter to insert a newline.`
    };
  }
  if (platform !== "darwin" || terminal !== "Apple_Terminal") {
    return {
      status: "unsupported",
      title: "Terminal setup unavailable",
      detail: "Automatic setup currently supports Apple Terminal on macOS. Shift+Enter and Ctrl+Enter still work when the terminal reports their modifiers."
    };
  }

  return setupAppleTerminal(options);
}

async function setupAppleTerminal(options: TerminalSetupOptions): Promise<TerminalSetupResult> {
  const run = options.run ?? execFileNoThrow;
  const homeDir = options.homeDir ?? homedir();
  const backupDir = join(homeDir, ".einsteins", "backups");
  const timestamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const randomId = options.randomId?.() ?? randomBytes(4).toString("hex");
  const makeDir = options.makeDir ?? mkdir;
  const backupPath = join(backupDir, `com.apple.Terminal.${timestamp}.${randomId}.plist`);
  const preferencesPath = join(homeDir, "Library", "Preferences", "com.apple.Terminal.plist");
  let preferencesChanged = false;

  await makeDir(backupDir, { recursive: true, mode: 0o700 });
  const backup = await run("/usr/bin/defaults", ["export", "com.apple.Terminal", backupPath], { useCwd: false });
  if (backup.code !== 0) throw new Error("Failed to back up Apple Terminal preferences; no settings were changed.");

  try {
    const defaultProfile = await readProfile(run, "Default Window Settings");
    const startupProfile = await readProfile(run, "Startup Window Settings");
    const profiles = [...new Set([defaultProfile, startupProfile])];

    for (const profile of profiles) {
      preferencesChanged = true;
      await enableOptionAsMeta(run, preferencesPath, profile);
    }
    await run("/usr/bin/killall", ["cfprefsd"], { useCwd: false });
    return {
      status: "configured",
      title: "Apple Terminal configured",
      detail: `Enabled Use Option as Meta key for ${profiles.join(", ")}. Restart Terminal.app, then use Option+Enter to insert a newline. Backup: ${backupPath}`,
      backupPath
    };
  } catch (error) {
    if (!preferencesChanged) throw error;
    const restore = await run("/usr/bin/defaults", ["import", "com.apple.Terminal", backupPath], { useCwd: false });
    await run("/usr/bin/killall", ["cfprefsd"], { useCwd: false });
    if (restore.code !== 0) {
      throw new Error(`Apple Terminal setup failed and automatic restore failed. Restore manually with: defaults import com.apple.Terminal ${backupPath}`);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Apple Terminal setup failed and the original preferences were restored: ${message}`);
  }
}

async function readProfile(run: typeof execFileNoThrow, key: string): Promise<string> {
  const result = await run("/usr/bin/defaults", ["read", "com.apple.Terminal", key], { useCwd: false });
  const profile = result.stdout.trim();
  if (result.code !== 0 || !profile) throw new Error(`Failed to read Apple Terminal profile: ${key}`);
  if (/[:\r\n]/.test(profile)) throw new Error(`Unsupported Apple Terminal profile name: ${profile}`);
  return profile;
}

async function enableOptionAsMeta(run: typeof execFileNoThrow, preferencesPath: string, profile: string): Promise<void> {
  const escapedProfile = profile.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
  const keyPath = `:'Window Settings':'${escapedProfile}':useOptionAsMetaKey`;
  const add = await run("/usr/libexec/PlistBuddy", ["-c", `Add ${keyPath} bool true`, preferencesPath], { useCwd: false });
  if (add.code === 0) return;
  const set = await run("/usr/libexec/PlistBuddy", ["-c", `Set ${keyPath} true`, preferencesPath], { useCwd: false });
  if (set.code !== 0) throw new Error(`Failed to enable Option as Meta for Apple Terminal profile: ${profile}`);
}
