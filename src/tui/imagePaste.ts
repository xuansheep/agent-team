import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { SelectImageAttachment } from "./components/CustomSelect/index.js";

const execFileAsync = promisify(execFile);
const maxImageBytes = 10 * 1024 * 1024;

export type ResolvedImagePaste = {
  text: string;
  images: Array<Omit<SelectImageAttachment, "id">>;
};

export async function resolveImagePaste(value: string, input: { cwd: string }): Promise<ResolvedImagePaste> {
  const parsed = parsePastedDataUrls(value);
  const fromPaths = await readImagesFromPastedPaths(parsed.text, input.cwd);
  if (fromPaths.images.length) {
    return { text: fromPaths.text, images: [...parsed.images, ...fromPaths.images] };
  }
  if (!parsed.text.trim()) {
    const clipboard = await readClipboardImage(input.cwd);
    if (clipboard) return { text: "", images: [...parsed.images, clipboard] };
  }
  return parsed;
}

export function parsePastedDataUrls(value: string): ResolvedImagePaste {
  const images: Array<Omit<SelectImageAttachment, "id">> = [];
  const text = value.replace(/data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)/g, (_match, mediaType: SelectImageAttachment["media_type"], data: string) => {
    if (data.trim()) images.push({ type: "image", media_type: mediaType, data });
    return "";
  }).trim();
  return { text, images };
}

export function isPastedImagePath(value: string): boolean {
  return imagePathFromText(value) !== undefined;
}

async function readImagesFromPastedPaths(value: string, cwd: string): Promise<ResolvedImagePaste> {
  const parts = pastedPathParts(value);
  if (!parts.length) return { text: value, images: [] };
  const images: Array<Omit<SelectImageAttachment, "id">> = [];
  const remaining: string[] = [];
  for (const part of parts) {
    const imagePath = imagePathFromText(part);
    if (!imagePath) {
      remaining.push(part);
      continue;
    }
    const image = await readImageFile(resolveImagePath(imagePath, cwd));
    if (image) images.push(image);
    else remaining.push(part);
  }
  return { text: remaining.join("\n").trim(), images };
}

function pastedPathParts(value: string): string[] {
  return value
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap((part) => part.split(/\r?\n/))
    .map((part) => part.trim())
    .filter(Boolean);
}

function imagePathFromText(value: string): string | undefined {
  const cleaned = stripBackslashEscapes(removeOuterQuotes(value.trim()));
  return /\.(png|jpe?g|webp)$/i.test(cleaned) ? cleaned : undefined;
}

function removeOuterQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function stripBackslashEscapes(value: string): string {
  if (process.platform === "win32") return value.replace(/\\ /g, " ");
  return value.replace(/\\\\/g, "\0").replace(/\\(.)/g, "$1").replace(/\0/g, "\\");
}

function resolveImagePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function readImageFile(path: string): Promise<Omit<SelectImageAttachment, "id"> | undefined> {
  try {
    const buffer = await readFile(path);
    if (buffer.length === 0 || buffer.length > maxImageBytes) return undefined;
    return { type: "image", media_type: mediaTypeForImage(path, buffer), data: buffer.toString("base64") };
  } catch {
    return undefined;
  }
}

function mediaTypeForImage(path: string, buffer: Buffer): SelectImageAttachment["media_type"] {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

async function readClipboardImage(cwd: string): Promise<Omit<SelectImageAttachment, "id"> | undefined> {
  if (process.platform !== "darwin") return undefined;
  const dir = join(cwd, ".tmp");
  const path = join(dir, "agent-team-latest-clipboard-image.png");
  const appleScriptPath = path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
  try {
    await mkdir(dir, { recursive: true });
    await execFileAsync("osascript", [
      "-e",
      "set png_data to (the clipboard as «class PNGf»)",
      "-e",
      `set fp to open for access POSIX file "${appleScriptPath}" with write permission`,
      "-e",
      "set eof fp to 0",
      "-e",
      "write png_data to fp",
      "-e",
      "close access fp"
    ]);
    const image = await readImageFile(path);
    return image ? { ...image, media_type: "image/png" } : undefined;
  } catch {
    return undefined;
  }
}
