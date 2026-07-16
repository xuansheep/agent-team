import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { acquireFileLease } from "./fileLease.js";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type ArtifactRef = {
  artifactId: string;
  path: string;
  revision: number;
  sha256: string;
};

export type ImageArtifactRef = ArtifactRef & {
  mediaType: ImageMediaType;
};

export type ArtifactRecord = {
  artifact_id: string;
  node_id: string;
  logical_name: string;
  revision: number;
  path: string;
  sha256: string;
  description: string;
  attempt: number;
  activation: number;
  created_at: string;
};

export type ArtifactTextChunk = {
  artifact_id: string;
  logical_name: string;
  description: string;
  sha256: string;
  content: string;
  offset: number;
  next_offset?: number;
  truncated: boolean;
  total_bytes: number;
};

type ArtifactIndex = { version: 1; artifacts: ArtifactRecord[] };

export class ArtifactStore {
  constructor(private readonly runDir: string) {}

  async writeText(nodeId: string, name: string, text: string, metadata: { description?: string; attempt?: number; activation?: number } = {}): Promise<ArtifactRef> {
    return this.writeRevision(nodeId, name, Buffer.from(text, "utf8"), metadata);
  }

  async importFile(nodeId: string, sourcePath: string, logicalName = basename(sourcePath), metadata: { description?: string; attempt?: number; activation?: number } = {}): Promise<ArtifactRef> {
    const bytes = await readFile(sourcePath);
    return this.writeRevision(nodeId, logicalName, bytes, metadata);
  }

  async copyInputImage(path: string): Promise<ImageArtifactRef> {
    const ref = await this.importFile("input", path);
    return { ...ref, mediaType: inferImageMediaType(path) };
  }

  async has(artifactId: string): Promise<boolean> {
    const record = await this.record(artifactId);
    if (!record) return false;
    try {
      const path = this.safeRecordPath(record);
      return sha256(await readFile(path)) === record.sha256;
    } catch {
      return false;
    }
  }

  async record(artifactId: string): Promise<ArtifactRecord | undefined> {
    return (await this.readIndex()).artifacts.find((item) => item.artifact_id === artifactId);
  }

  async readText(artifactId: string, options: { offset?: number; maxBytes?: number } = {}): Promise<ArtifactTextChunk> {
    const record = await this.record(artifactId);
    if (!record) throw new Error(`Unknown artifact ${artifactId}`);
    const path = this.safeRecordPath(record);
    const bytes = await readFile(path);
    const actualHash = sha256(bytes);
    if (actualHash !== record.sha256) throw new Error(`Artifact integrity check failed for ${artifactId}`);

    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`Artifact ${artifactId} is not valid UTF-8 text`);
    }

    const requestedOffset = options.offset ?? 0;
    const maxBytes = options.maxBytes ?? 64 * 1024;
    if (!Number.isInteger(requestedOffset) || requestedOffset < 0 || requestedOffset > bytes.length) {
      throw new Error(`Invalid artifact offset ${requestedOffset}`);
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 128 * 1024) {
      throw new Error(`Invalid artifact maxBytes ${maxBytes}`);
    }

    const offset = nextUtf8Boundary(bytes, requestedOffset);
    const proposedEnd = Math.min(bytes.length, offset + maxBytes);
    const end = previousUtf8Boundary(bytes, proposedEnd, offset);
    const nextOffset = end < bytes.length ? end : undefined;
    return {
      artifact_id: record.artifact_id,
      logical_name: record.logical_name,
      description: record.description,
      sha256: record.sha256,
      content: bytes.subarray(offset, end).toString("utf8"),
      offset,
      ...(nextOffset !== undefined ? { next_offset: nextOffset } : {}),
      truncated: nextOffset !== undefined,
      total_bytes: bytes.length
    };
  }

  private async writeRevision(nodeId: string, logicalName: string, bytes: Buffer, metadata: { description?: string; attempt?: number; activation?: number }): Promise<ArtifactRef> {
    assertArtifactSegment(nodeId, "node id");
    const safeName = basename(logicalName);
    assertArtifactSegment(safeName, "logical name");
    const artifactsDir = join(this.runDir, "artifacts");
    const lease = await acquireFileLease(join(artifactsDir, "index.lease"), "Artifact index", { wait: true });
    try {
      const index = await this.readIndex();
      const allocated = this.allocateRevision(index, nodeId, safeName, bytes, metadata);
      await mkdir(join(artifactsDir, nodeId), { recursive: true });
      await writeFile(allocated.path, bytes);
      await this.writeIndex({ version: 1, artifacts: [...index.artifacts, allocated.record] });
      return publicRef(allocated.record);
    } finally {
      await lease.release();
    }
  }

  private allocateRevision(index: ArtifactIndex, nodeId: string, logicalName: string, bytes: Buffer, metadata: { description?: string; attempt?: number; activation?: number }) {
    const revision = Math.max(0, ...index.artifacts.filter((item) => item.node_id === nodeId && item.logical_name === logicalName).map((item) => item.revision)) + 1;
    const record: ArtifactRecord = {
      artifact_id: `${nodeId}/${logicalName}@r${revision}`,
      node_id: nodeId,
      logical_name: logicalName,
      revision,
      path: join(this.runDir, "artifacts", nodeId, `r${String(revision).padStart(4, "0")}-${logicalName}`),
      sha256: sha256(bytes),
      description: metadata.description ?? "",
      attempt: metadata.attempt ?? 1,
      activation: metadata.activation ?? 1,
      created_at: new Date().toISOString()
    };
    return { path: record.path, record };
  }

  private safeRecordPath(record: ArtifactRecord): string {
    const artifactsRoot = resolve(this.runDir, "artifacts");
    const candidate = resolve(isAbsolute(record.path) ? record.path : join(this.runDir, record.path));
    const fromRoot = relative(artifactsRoot, candidate);
    if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
      throw new Error(`Artifact path escapes the current run: ${record.artifact_id}`);
    }
    return candidate;
  }

  private async writeIndex(index: ArtifactIndex): Promise<void> {
    const artifactsDir = join(this.runDir, "artifacts");
    await mkdir(artifactsDir, { recursive: true });
    try {
      const current = await readFile(join(artifactsDir, "index.json"), "utf8");
      JSON.parse(current);
      await writeFile(join(artifactsDir, "index.backup.json"), current, "utf8");
    } catch (error) {
      if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
    }
    await writeFile(join(artifactsDir, "index.json"), `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  private async readIndex(): Promise<ArtifactIndex> {
    for (const name of ["index.json", "index.backup.json"]) {
      try {
        const parsed = JSON.parse(await readFile(join(this.runDir, "artifacts", name), "utf8")) as ArtifactIndex;
        if (parsed.version === 1 && Array.isArray(parsed.artifacts)) return parsed;
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !(error instanceof SyntaxError)) throw error;
      }
    }
    return { version: 1, artifacts: [] };
  }
}

function nextUtf8Boundary(bytes: Uint8Array, offset: number): number {
  let result = offset;
  while (result < bytes.length && (bytes[result] & 0xc0) === 0x80) result += 1;
  return result;
}

function previousUtf8Boundary(bytes: Uint8Array, offset: number, minimum: number): number {
  let result = offset;
  while (result > minimum && result < bytes.length && (bytes[result] & 0xc0) === 0x80) result -= 1;
  return result;
}

function assertArtifactSegment(value: string, label: string): void {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || /[<>:"|?*\u0000-\u001f]/.test(value)) {
    throw new Error(`Invalid artifact ${label}: ${value}`);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === code);
}

function publicRef(record: ArtifactRecord): ArtifactRef {
  return { artifactId: record.artifact_id, path: record.path, revision: record.revision, sha256: record.sha256 };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function inferImageMediaType(path: string): ImageMediaType {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
