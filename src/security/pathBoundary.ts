import { isAbsolute, relative, resolve } from "node:path";

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const root = resolve(cwd);
  const normalizedInput = normalizeWorkspaceInputPath(inputPath);
  const target = isAbsolute(normalizedInput) ? resolve(normalizedInput) : resolve(root, normalizedInput);
  if (!isPathInsideOrSame(root, target)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return target;
}

export function normalizeWorkspaceInputPath(inputPath: string, platform = process.platform): string {
  if (platform !== "win32") return inputPath;
  const msysDrivePath = /^\/([A-Za-z])(?:\/(.*))?$/.exec(inputPath.replace(/\\/g, "/"));
  if (!msysDrivePath) return inputPath;
  const drive = msysDrivePath[1]!.toUpperCase();
  const tail = msysDrivePath[2] ?? "";
  return `${drive}:\\${tail.replace(/\//g, "\\")}`;
}

export function isPathInsideOrSame(rootPath: string, targetPath: string): boolean {
  const root = resolve(rootPath);
  const target = resolve(targetPath);
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// Absolute patterns are legitimate as long as they stay inside the workspace, so the check runs
// against the literal prefix that precedes the first wildcard segment.
export function assertGlobInsideWorkspace(cwd: string, pattern: string): void {
  const normalized = pattern.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.includes("..")) throw new Error(`Glob pattern escapes workspace: ${pattern}`);
  if (!isAbsolute(pattern) && !/^[A-Za-z]:/.test(normalized)) return;
  const wildcard = segments.findIndex((segment) => /[*?[\]{}]/.test(segment));
  const base = (wildcard === -1 ? segments : segments.slice(0, wildcard)).join("/");
  if (!isPathInsideOrSame(cwd, base)) throw new Error(`Glob pattern escapes workspace: ${pattern}`);
}
