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
