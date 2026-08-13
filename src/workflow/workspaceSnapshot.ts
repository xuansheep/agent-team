import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

export type WorkspaceSnapshot = {
  sha256: string;
  file_count: number;
  total_bytes: number;
  complete: boolean;
  files: Record<string, string>;
};

export type WorkspaceSnapshotDiff = {
  changed: boolean;
  changed_paths: string[];
  truncated: boolean;
};

const fileHashCache = new Map<string, { size: number; mtimeMs: number; ctimeMs: number; sha256: string }>();

const excludedDirectories = new Set([
  ".git", ".tmp", ".session", ".cache", ".next", ".nuxt", ".turbo",
  "node_modules", "dist", "dist-test", "build", "coverage", "target", "out", ".einsteins"
]);

export async function captureWorkspaceSnapshot(
  cwd: string,
  limits: { maxFiles?: number; maxBytes?: number } = {}
): Promise<WorkspaceSnapshot> {
  const root = resolve(cwd);
  const maxFiles = limits.maxFiles ?? 20_000;
  const maxBytes = limits.maxBytes ?? 100 * 1024 * 1024;
  const files: Record<string, string> = {};
  let totalBytes = 0;
  let complete = true;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (!complete) return;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute);
      if (Object.keys(files).length >= maxFiles || totalBytes + info.size > maxBytes) {
        complete = false;
        return;
      }
      const cached = fileHashCache.get(absolute);
      let digest: string;
      if (cached && cached.size === info.size && cached.mtimeMs === info.mtimeMs && cached.ctimeMs === info.ctimeMs) {
        digest = cached.sha256;
      } else {
        const bytes = await readFile(absolute);
        digest = createHash("sha256").update(bytes).digest("hex");
        fileHashCache.set(absolute, { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, sha256: digest });
      }
      const path = relative(root, absolute).split(sep).join("/");
      files[path] = digest;
      totalBytes += info.size;
    }
  };

  try {
    await walk(root);
  } catch (error) {
    if (!error || typeof error !== "object" || (error as { code?: unknown }).code !== "ENOENT") throw error;
    complete = false;
  }
  const hash = createHash("sha256");
  for (const [path, digest] of Object.entries(files)) hash.update(path).update("\0").update(digest).update("\0");
  hash.update(complete ? "complete" : "truncated");
  return {
    sha256: hash.digest("hex"),
    file_count: Object.keys(files).length,
    total_bytes: totalBytes,
    complete,
    files
  };
}

export function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot, limit = 200): WorkspaceSnapshotDiff {
  const paths = new Set([...Object.keys(before.files), ...Object.keys(after.files)]);
  const changedPaths = [...paths].filter((path) => before.files[path] !== after.files[path]).sort();
  return {
    changed: before.sha256 !== after.sha256,
    changed_paths: changedPaths.slice(0, limit),
    truncated: changedPaths.length > limit || !before.complete || !after.complete
  };
}
