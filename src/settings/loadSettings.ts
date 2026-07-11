import { chmod, mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import yaml from "js-yaml";
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
  return join(homedir(), ".einsteins", "settings.yaml");
}

function defaultProjectSettingsPath(cwd: string): string {
  return join(cwd, ".einsteins", "settings.yaml");
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
  await ensureUserSettingsFile(path);
  const settings = settingsSchema.parse(yaml.load(await readFile(path, "utf8")) ?? {});
  const next = {
    ...settings,
    permissions: { ...settings.permissions, defaultMode: mode }
  };
  const existingMode = (await stat(path)).mode;
  const temporaryPath = `${path}.tmp.${process.pid}.${randomUUID()}`;
  const handle = await open(temporaryPath, "wx", existingMode);
  try {
    await handle.writeFile(yaml.dump(next, { lineWidth: -1, noRefs: true }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, existingMode);
  await rename(temporaryPath, path);
}

async function readSettingsFile(path: string, source: "user"): Promise<AgentTeamSettings | undefined>;
async function readSettingsFile(path: string, source: "project"): Promise<ProjectAgentTeamSettings | undefined>;
async function readSettingsFile(path: string, source: "user" | "project"): Promise<AgentTeamSettings | ProjectAgentTeamSettings | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = yaml.load(raw) ?? {};
    if (source === "project" && parsed && typeof parsed === "object" && Object.hasOwn(parsed, "providers")) {
      throw new Error(`Project settings cannot define providers: ${path}`);
    }
    return source === "user" ? settingsSchema.parse(parsed) : projectSettingsSchema.parse(parsed);
  } catch (error) {
    if ((error as { code?: unknown }).code !== "ENOENT") throw error;
    return undefined;
  }
}

export const DEFAULT_USER_SETTINGS = `providers:
  default:
    type: responses-api
    base_url: https://api.openai.com/v1
    api_key: ""
    default_model: gpt-5.5
    api_key_mode: bearer
    capabilities:
      tool_calling: true
      vision: true
      streaming: true
      json_schema_output: true
  openai_compatible:
    type: openai-compatible
    base_url: https://api.example.com/v1
    api_key: ""
    default_model: model-name
    api_key_mode: bearer
    capabilities:
      tool_calling: true
      vision: false
      streaming: true
      json_schema_output: true
  anthropic:
    type: anthropic
    base_url: https://api.anthropic.com
    api_key: ""
    default_model: claude-sonnet-4-5
    api_key_mode: x-api-key
    capabilities:
      tool_calling: true
      vision: true
      streaming: true
      json_schema_output: true
`;
