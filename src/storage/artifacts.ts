import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { acquireFileLease } from "./fileLease.js";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";
export type ArtifactKind = "text" | "image" | "binary";

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
  kind?: ArtifactKind;
  media_type?: ImageMediaType;
};

export type ArtifactContent = {
  record: ArtifactRecord;
  kind: ArtifactKind;
  mediaType?: ImageMediaType;
  bytes: Buffer;
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

const maxInputImageBytes = 10 * 1024 * 1024;

type ArtifactIndex = { version: 1; artifacts: ArtifactRecord[] };
type ArtifactMetadata = {
  description?: string;
  attempt?: number;
  activation?: number;
  kind?: ArtifactKind;
  mediaType?: ImageMediaType;
};

export class ArtifactStore {
  constructor(private readonly runDir: string) {}

  async writeText(nodeId: string, name: string, text: string, metadata: Omit<ArtifactMetadata, "kind" | "mediaType"> = {}): Promise<ArtifactRef> {
    return this.writeRevision(nodeId, name, Buffer.from(text, "utf8"), { ...metadata, kind: "text" });
  }

  async importFile(nodeId: string, sourcePath: string, logicalName = basename(sourcePath), metadata: ArtifactMetadata = {}): Promise<ArtifactRef> {
    const bytes = await readFile(sourcePath);
    const safeName = basename(logicalName);
    const mediaType = metadata.mediaType ?? imageMediaTypeFromPath(safeName);
    const kind = metadata.kind ?? (mediaType ? "image" : isValidUtf8(bytes) ? "text" : "binary");
    return this.writeRevision(nodeId, safeName, bytes, {
      ...metadata,
      kind: kind === "image" && !mediaType ? "binary" : kind,
      ...(mediaType ? { mediaType } : {})
    });
  }

  async copyInputImage(path: string): Promise<ImageArtifactRef> {
    const mediaType = inferImageMediaType(path);
    const ref = await this.importFile("input", path, basename(path), { kind: "image", mediaType });
    return { ...ref, mediaType };
  }

  async writeInputImage(data: string, mediaType: ImageMediaType, logicalName?: string): Promise<ImageArtifactRef> {
    const encoded = data.replace(/\s/g, "");
    const bytes = Buffer.from(encoded, "base64");
    const canonical = bytes.toString("base64").replace(/=+$/, "");
    if (!bytes.length || canonical !== encoded.replace(/=+$/, "")) {
      throw new Error("Input image is not valid base64");
    }
    if (bytes.length > maxInputImageBytes) {
      throw new Error(`Input image exceeds ${maxInputImageBytes} bytes`);
    }
    const signatureMatches = mediaType === "image/png"
      ? bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : mediaType === "image/jpeg"
        ? bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
        : bytes.subarray(0, 4).toString("ascii") === "RIFF"
          && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    if (!signatureMatches) {
      throw new Error(`Input image data does not match declared media type ${mediaType}`);
    }
    const name = logicalName ?? (mediaType === "image/jpeg"
      ? "input-image.jpg"
      : mediaType === "image/webp"
        ? "input-image.webp"
        : "input-image.png");
    const ref = await this.writeRevision("input", name, bytes, {
      kind: "image",
      mediaType,
      description: "User-provided input image"
    });
    return { ...ref, mediaType };
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

  async list(): Promise<ArtifactRecord[]> {
    return (await this.readIndex()).artifacts.map((record) => ({ ...record }));
  }

  async read(artifactId: string): Promise<ArtifactContent> {
    const record = await this.record(artifactId);
    if (!record) throw new Error(`Unknown artifact ${artifactId}`);
    const bytes = await readFile(this.safeRecordPath(record));
    if (sha256(bytes) !== record.sha256) throw new Error(`Artifact integrity check failed for ${artifactId}`);

    const inferredMediaType = record.media_type ?? imageMediaTypeFromPath(record.logical_name);
    const declaredKind = record.kind ?? (inferredMediaType ? "image" : isValidUtf8(bytes) ? "text" : "binary");
    const kind = declaredKind === "text" && !isValidUtf8(bytes) ? "binary" : declaredKind;
    if (kind === "image" && !inferredMediaType) return { record, kind: "binary", bytes };
    return { record, kind, ...(kind === "image" ? { mediaType: inferredMediaType } : {}), bytes };
  }

  async readText(artifactId: string, options: { offset?: number; maxBytes?: number } = {}): Promise<ArtifactTextChunk> {
    const artifact = await this.read(artifactId);
    const { record, bytes } = artifact;
    if (artifact.kind !== "text" || !isValidUtf8(bytes)) {
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

  private async writeRevision(nodeId: string, logicalName: string, bytes: Buffer, metadata: ArtifactMetadata): Promise<ArtifactRef> {
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

  private allocateRevision(index: ArtifactIndex, nodeId: string, logicalName: string, bytes: Buffer, metadata: ArtifactMetadata) {
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
      created_at: new Date().toISOString(),
      kind: metadata.kind ?? "binary",
      ...(metadata.mediaType ? { media_type: metadata.mediaType } : {})
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

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function imageMediaTypeFromPath(path: string): ImageMediaType | undefined {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return undefined;
}

export function inferImageMediaType(path: string): ImageMediaType {
  return imageMediaTypeFromPath(path) ?? "image/png";
}
