import { isAbsolute, relative, resolve } from "node:path";

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const root = resolve(cwd);
  const target = isAbsolute(inputPath) ? resolve(inputPath) : resolve(root, inputPath);
  if (!isPathInsideOrSame(root, target)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return target;
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
