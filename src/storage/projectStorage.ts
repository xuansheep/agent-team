import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { projectDirectoriesToGitRoot } from "../context/projectDirectories.js";
import { updateJsonAtomic } from "./atomicJson.js";

export const MAX_SANITIZED_PROJECT_LENGTH = 200;

export type ProjectStorageContext = {
  homeDir: string;
  projectsDir: string;
  projectDir: string;
  projectPath: string;
  projectKey: string;
};

type ProjectIdentity = {
  version: 1;
  projectPath: string;
  projectKey: string;
  createdAt: string;
};

export async function prepareProjectStorage(options: { cwd: string; homeDir?: string }): Promise<ProjectStorageContext> {
  const home = resolve(options.homeDir ?? homedir());
  const projectPath = await resolveProjectPath(options.cwd, options.homeDir);
  const projectKey = sanitizeProjectPath(projectPath);
  const projectsDir = join(home, ".einsteins", "projects");
  const projectDir = join(projectsDir, projectKey);
  const identityPath = join(projectDir, "project.json");

  await updateJsonAtomic<ProjectIdentity>(identityPath, (existing) => {
    if (existing && comparableProjectPath(existing.projectPath) !== comparableProjectPath(projectPath)) {
      throw new Error(`Project storage key collision: ${projectKey} maps both ${existing.projectPath} and ${projectPath}`);
    }
    return existing ?? {
      version: 1,
      projectPath,
      projectKey,
      createdAt: new Date().toISOString()
    };
  }, { backupPath: false });

  return { homeDir: home, projectsDir, projectDir, projectPath, projectKey };
}

export function sanitizeProjectPath(name: string): string {
  const normalized = name.normalize("NFC");
  const sanitized = normalized.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_PROJECT_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_SANITIZED_PROJECT_LENGTH)}-${Math.abs(djb2Hash(normalized)).toString(36)}`;
}

export function sessionDirectory(storage: ProjectStorageContext | string, sessionId: string): string {
  assertStorageId(sessionId, "sessionId");
  return join(projectDirectory(storage), sessionId);
}

export function runDirectory(storage: ProjectStorageContext | string, sessionId: string, runId: string): string {
  assertStorageId(runId, "runId");
  return join(sessionDirectory(storage, sessionId), "runs", runId);
}

export function projectDirectory(storage: ProjectStorageContext | string): string {
  return typeof storage === "string" ? resolve(storage) : storage.projectDir;
}

export function projectPath(storage: ProjectStorageContext | string): string {
  return typeof storage === "string" ? resolve(storage) : storage.projectPath;
}

export function assertStorageId(value: string, label: string): void {
  if (!value || value === "." || value === ".." || value.length > 200 || !/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

async function resolveProjectPath(cwd: string, homeDir?: string): Promise<string> {
  const resolvedCwd = resolve(cwd).normalize("NFC");
  const directories = await projectDirectoriesToGitRoot(resolvedCwd, homeDir);
  const candidate = directories.at(-1);
  if (candidate && await exists(join(candidate, ".git"))) return resolve(candidate).normalize("NFC");
  return resolvedCwd;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isErrno(error, "ENOENT")) return false;
    throw error;
  }
}

function comparableProjectPath(path: string): string {
  const normalized = resolve(path).normalize("NFC");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function djb2Hash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}
