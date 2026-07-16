import { chmod, mkdir, open, readFile, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, join } from "node:path";
import { AgentTeamSettings, ProjectAgentTeamSettings, ResolvedAgentTeamSettings, projectSettingsSchema, settingsSchema } from "./types.js";
import { resolveSettings } from "./resolveSettings.js";
import type { PermissionMode } from "../permissions/PermissionMode.js";

export type LoadSettingsOptions = {
  cwd: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
};

export async function loadSettings(options: LoadSettingsOptions): Promise<ResolvedAgentTeamSettings> {
  const userSettingsPath = options.userSettingsPath ?? defaultUserSettingsPath();
  await ensureUserSettingsFile(userSettingsPath);
  const userSettings = await readSettingsFile(userSettingsPath, "user");
  const projectSettings = await readSettingsFile(options.projectSettingsPath ?? defaultProjectSettingsPath(options.cwd), "project");
  return resolveSettings({ cwd: options.cwd, userSettings, projectSettings });
}

export function defaultUserSettingsPath(): string {
  return join(homedir(), ".einsteins", "settings.json");
}

export function defaultProjectSettingsPath(cwd: string): string {
  return join(cwd, ".einsteins", "settings.json");
}

export async function ensureUserSettingsFile(path = defaultUserSettingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(DEFAULT_USER_SETTINGS, "utf8");
  } catch (error) {
    if ((error as { code?: unknown }).code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
}

export async function setUserDefaultPermissionMode(
  mode: Extract<PermissionMode, "default" | "fullAccess">,
  path = defaultUserSettingsPath()
): Promise<void> {
  await updateUserSettingsFile(path, (settings) => ({
    ...settings,
    permissions: { ...settings.permissions, defaultMode: mode }
  }));
}

export async function updateUserSettingsFile(
  path: string,
  update: (settings: AgentTeamSettings) => AgentTeamSettings
): Promise<void> {
  await ensureUserSettingsFile(path);
  await withSettingsLock(path, async () => {
    const settings = settingsSchema.parse(parseSettingsJson(await readFile(path, "utf8"), path));
    await writeSettingsAtomic(path, settingsSchema.parse(update(settings)));
  });
}

async function withSettingsLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  let lock: FileHandle | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      await delay(50);
    }
  }
  if (!lock) throw new Error(`Timed out acquiring settings lock ${lockPath}`);
  try {
    return await operation();
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

async function writeSettingsAtomic(path: string, settings: AgentTeamSettings): Promise<void> {
  const existingMode = (await stat(path)).mode;
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", existingMode);
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporaryPath, existingMode);
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function readSettingsFile(path: string, source: "user"): Promise<AgentTeamSettings | undefined>;
async function readSettingsFile(path: string, source: "project"): Promise<ProjectAgentTeamSettings | undefined>;
async function readSettingsFile(path: string, source: "user" | "project"): Promise<AgentTeamSettings | ProjectAgentTeamSettings | undefined> {
  try {
    const parsed = parseSettingsJson(await readFile(path, "utf8"), path);
    if (source === "project" && parsed && typeof parsed === "object" && Object.hasOwn(parsed, "providers")) {
      throw new Error("Project settings cannot define providers: " + path);
    }
    return source === "user" ? settingsSchema.parse(parsed) : projectSettingsSchema.parse(parsed);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return undefined;
  }
}

function parseSettingsJson(raw: string, path: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error("Invalid JSON settings in " + path + ": " + (error instanceof Error ? error.message : String(error)));
  }
}

export const DEFAULT_USER_SETTINGS = JSON.stringify({
  providers: {
    default: {
      type: "responses-api",
      base_url: "https://api.openai.com/v1",
      api_key: "",
      default_model: "gpt-5.5",
      effort: "medium",
      api_key_mode: "bearer",
      capabilities: {
        tool_calling: true,
        vision: true,
        streaming: true,
        json_schema_output: true
      }
    },
    openai_compatible: {
      type: "openai-compatible",
      base_url: "https://api.example.com/v1",
      api_key: "",
      default_model: "model-name",
      effort: "medium",
      api_key_mode: "bearer",
      capabilities: {
        tool_calling: true,
        vision: false,
        streaming: true,
        json_schema_output: true
      }
    },
    anthropic: {
      type: "anthropic",
      base_url: "https://api.anthropic.com",
      api_key: "",
      default_model: "claude-sonnet-4-5",
      effort: "medium",
      api_key_mode: "x-api-key",
      capabilities: {
        tool_calling: true,
        vision: true,
        streaming: true,
        json_schema_output: true
      }
    }
  }
}, null, 2) + "\n";
