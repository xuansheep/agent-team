import { relative, resolve } from "node:path";

export function resolveWorkspacePath(cwd: string, inputPath: string): string {
  const resolved = resolve(cwd, inputPath);
  const rel = relative(cwd, resolved);
  if (rel.startsWith("..") || rel === ".." || rel.includes(`..${resolve("/").slice(0, 1)}`)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}
