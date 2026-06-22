import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp";

export type ArtifactRef = {
  artifactId: string;
  path: string;
};

export type ImageArtifactRef = ArtifactRef & {
  mediaType: ImageMediaType;
};

export class ArtifactStore {
  constructor(private readonly runDir: string) {}

  async writeText(nodeId: string, name: string, text: string): Promise<ArtifactRef> {
    const dir = join(this.runDir, "artifacts", nodeId);
    await mkdir(dir, { recursive: true });
    const path = join(dir, name);
    await writeFile(path, text, "utf8");
    return { artifactId: `${nodeId}/${name}`, path };
  }

  async copyInputImage(path: string): Promise<ImageArtifactRef> {
    const dir = join(this.runDir, "artifacts", "input");
    await mkdir(dir, { recursive: true });
    const target = join(dir, basename(path));
    await copyFile(path, target);
    return { artifactId: `input/${basename(path)}`, path: target, mediaType: inferImageMediaType(path) };
  }
}

export function inferImageMediaType(path: string): ImageMediaType {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}
