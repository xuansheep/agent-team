import { createHash } from "node:crypto";
import { join } from "node:path";
import { ArtifactStore } from "./artifacts.js";
import { readJsonWithBackup, updateJsonAtomic } from "./atomicJson.js";

export const TOOL_RESULT_PROJECTION_THRESHOLD_BYTES = 2 * 1024;
export const MAX_PROJECTED_TOOL_RESULT_TOKENS = 10_000;
export const MAX_PROJECTED_TOOL_RESULT_BYTES = MAX_PROJECTED_TOOL_RESULT_TOKENS * 4;
export const DEFAULT_TOOL_RESULT_PROJECTION_BYTES = 2 * 1024;

export type ToolResultProjectionOptions = {
  tokenLimit?: number;
  byteLimit?: number;
};

export type ProjectionRecord = {
  version: 1;
  tool_call_id: string;
  content_sha256: string;
  projection_sha256: string;
  original_bytes: number;
  projected_bytes: number;
  projected: boolean;
  reference_description: string;
  projected_content: string;
  artifact_id?: string;
};

type ProjectionIndex = {
  version: 1;
  records: ProjectionRecord[];
};

export function createToolResultProjection(
  toolCallId: string,
  value: unknown,
  options: ToolResultProjectionOptions = {}
): ProjectionRecord {
  const original = serializeToolResult(value);
  const source = Buffer.from(original, "utf8");
  const contentSha256 = sha256(source);
  const maxBytes = Math.min(projectionByteLimit(options), TOOL_RESULT_PROJECTION_THRESHOLD_BYTES);
  const referenceDescription = `tool_call_id=${JSON.stringify(toolCallId)} content_sha256=${contentSha256}`;
  const shouldProject = source.byteLength > TOOL_RESULT_PROJECTION_THRESHOLD_BYTES || source.byteLength > maxBytes;
  const projectedContent = shouldProject
    ? headTailProjection(source, maxBytes, referenceDescription, contentSha256)
    : original;
  const projectedBytes = Buffer.byteLength(projectedContent, "utf8");

  return {
    version: 1,
    tool_call_id: toolCallId,
    content_sha256: contentSha256,
    projection_sha256: sha256(Buffer.from(projectedContent, "utf8")),
    original_bytes: source.byteLength,
    projected_bytes: projectedBytes,
    projected: shouldProject,
    reference_description: referenceDescription,
    projected_content: projectedContent
  };
}

export class ToolResultProjectionStore {
  private readonly indexPath: string;

  constructor(private readonly runDir: string) {
    this.indexPath = join(runDir, "tool-result-projections", "index.json");
  }

  async persist(
    toolCallId: string,
    value: unknown,
    options: ToolResultProjectionOptions & { nodeId?: string; attempt?: number; activation?: number } = {}
  ): Promise<ProjectionRecord> {
    const projection = createToolResultProjection(toolCallId, value, options);
    const existing = await this.find(toolCallId, projection.content_sha256);
    if (existing) return existing;

    let record = projection;
    if (projection.projected) {
      const original = serializeToolResult(value);
      const ref = await new ArtifactStore(this.runDir).writeText(
        options.nodeId ?? "tool-results",
        `tool-result-${projection.content_sha256}.txt`,
        original,
        {
          description: `Full tool result for ${projection.reference_description}`,
          attempt: options.attempt,
          activation: options.activation
        }
      );
      record = projectionWithArtifactReference(projection, value, ref.artifactId);
    }

    const index = await updateJsonAtomic<ProjectionIndex>(
      this.indexPath,
      (current) => {
        const normalized = normalizeIndex(current);
        const duplicate = normalized.records.find((item) =>
          item.tool_call_id === record.tool_call_id && item.content_sha256 === record.content_sha256
        );
        return duplicate ? normalized : { version: 1, records: [...normalized.records, record] };
      },
      { backupPath: false }
    );
    return index.records.find((item) =>
      item.tool_call_id === record.tool_call_id && item.content_sha256 === record.content_sha256
    ) ?? record;
  }

  async find(toolCallId: string, contentSha256: string): Promise<ProjectionRecord | undefined> {
    const index = normalizeIndex(await readJsonWithBackup<ProjectionIndex>(this.indexPath, { backupPath: false }));
    const record = index.records.find((item) =>
      item.tool_call_id === toolCallId && item.content_sha256 === contentSha256
    );
    return record ? { ...record } : undefined;
  }

  async replay(toolCallId: string, contentSha256: string): Promise<string | undefined> {
    const record = await this.find(toolCallId, contentSha256);
    if (!record) return undefined;
    if (sha256(Buffer.from(record.projected_content, "utf8")) !== record.projection_sha256) {
      throw new Error(`Tool result projection integrity check failed for ${toolCallId}/${contentSha256}`);
    }
    return record.projected_content;
  }
}

function projectionWithArtifactReference(
  projection: ProjectionRecord,
  value: unknown,
  artifactId: string
): ProjectionRecord {
  const artifactReference = `\nFull result artifact_id=${JSON.stringify(artifactId)}\n`;
  const targetBytes = Math.max(1, projection.projected_bytes - Buffer.byteLength(artifactReference, "utf8"));
  const base = createToolResultProjection(projection.tool_call_id, value, { byteLimit: targetBytes });
  const projectedContent = `${base.projected_content}${artifactReference}`;
  return {
    ...base,
    projected_content: projectedContent,
    projected_bytes: Buffer.byteLength(projectedContent, "utf8"),
    projection_sha256: sha256(Buffer.from(projectedContent, "utf8")),
    artifact_id: artifactId
  };
}

function projectionByteLimit(options: ToolResultProjectionOptions): number {
  if (options.tokenLimit !== undefined) {
    return Math.min(MAX_PROJECTED_TOOL_RESULT_BYTES, Math.max(1, Math.floor(options.tokenLimit)) * 4);
  }
  if (options.byteLimit !== undefined) {
    return Math.min(MAX_PROJECTED_TOOL_RESULT_BYTES, Math.max(1, Math.floor(options.byteLimit)));
  }
  return DEFAULT_TOOL_RESULT_PROJECTION_BYTES;
}

function headTailProjection(
  source: Buffer,
  maxBytes: number,
  referenceDescription: string,
  contentSha256: string
): string {
  const marker = `\n… tool result projected; original_bytes=${source.byteLength}; sha256=${contentSha256}; reference: ${referenceDescription} …\n`;
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return utf8Prefix(Buffer.from(marker, "utf8"), maxBytes);

  const contentBudget = maxBytes - markerBytes;
  const headBudget = Math.ceil(contentBudget / 2);
  const tailBudget = contentBudget - headBudget;
  return `${utf8Prefix(source, headBudget)}${marker}${utf8Suffix(source, tailBudget)}`;
}

function serializeToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  const serialized = JSON.stringify(sortJson(value));
  return serialized ?? String(value);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function normalizeIndex(index: ProjectionIndex | undefined): ProjectionIndex {
  if (!index || index.version !== 1 || !Array.isArray(index.records)) {
    return { version: 1, records: [] };
  }
  return { version: 1, records: index.records };
}

function utf8Prefix(source: Buffer, maxBytes: number): string {
  let end = Math.min(source.byteLength, maxBytes);
  while (end > 0 && (source[end]! & 0xc0) === 0x80) end -= 1;
  return source.subarray(0, end).toString("utf8");
}

function utf8Suffix(source: Buffer, maxBytes: number): string {
  let start = Math.max(0, source.byteLength - maxBytes);
  while (start < source.byteLength && (source[start]! & 0xc0) === 0x80) start += 1;
  return source.subarray(start).toString("utf8");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
