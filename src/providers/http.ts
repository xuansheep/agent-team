import { fetch } from "undici";
import { ModelErrorKind, ModelProviderError } from "./types.js";

export type ApiKeyMode = "bearer" | "x-api-key";
export type ProviderNetworkError = ModelProviderError;

export const defaultProviderUserAgent = "claude-code/2.1.186";

const providerNetworkAttempts = 5;

export function buildApiKeyHeaders(apiKey: string, mode: ApiKeyMode): Record<string, string> {
  return mode === "x-api-key"
    ? { "x-api-key": apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

export async function fetchProvider(endpoint: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= providerNetworkAttempts; attempt += 1) {
    try {
      return await fetch(endpoint, init);
    } catch (error) {
      lastError = error;
      if (attempt === providerNetworkAttempts) break;
      await delay(attempt * 25);
    }
  }

  const message = errorMessage(lastError);
  throw new ModelProviderError(`Provider network request failed after ${providerNetworkAttempts} attempts: ${message}`, {
    errorKind: "network",
    detail: providerNetworkDetail(endpoint, providerNetworkAttempts, lastError),
    cause: lastError
  });
}

export function providerHttpError(status: number, body: string): ModelProviderError {
  return new ModelProviderError(`Provider request failed ${status}: ${body}`, { errorKind: classifyProviderStatus(status), status });
}

export function classifyProviderStatus(status: number): ModelErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

export async function consumeSseBlocks(
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } },
  onData: (data: string) => boolean | void
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  while (!done) {
    const chunk = await reader.read();
    if (chunk.done) {
      buffer += decoder.decode();
      done = true;
    } else {
      buffer += decoder.decode(chunk.value, { stream: true });
    }

    let separatorIndex = buffer.indexOf("\n\n");
    while (separatorIndex !== -1) {
      const block = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      if (consumeSseBlock(block, onData)) return true;
      separatorIndex = buffer.indexOf("\n\n");
    }
  }

  if (buffer.trim()) return consumeSseBlock(buffer, onData);
  return false;
}

function consumeSseBlock(block: string, onData: (data: string) => boolean | void): boolean {
  const data = block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) return false;
  if (data === "[DONE]") return true;
  return onData(data) === true;
}

function providerNetworkDetail(endpoint: string, attempts: number, error: unknown): string {
  const cause = nestedCause(error) ?? error;
  return [
    `endpoint: ${endpoint}`,
    `attempts: ${attempts}`,
    ...errorDetailLines("error", error),
    ...errorDetailLines("cause", cause)
  ].join("\n");
}

function errorDetailLines(prefix: string, value: unknown): string[] {
  if (value instanceof Error) {
    const code = errorCode(value);
    return [
      `${prefix}.name: ${value.name}`,
      `${prefix}.message: ${value.message}`,
      ...(code ? [`${prefix}.code: ${code}`] : [])
    ];
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return ["name", "message", "code"]
      .filter((key) => typeof record[key] === "string" || typeof record[key] === "number")
      .map((key) => `${prefix}.${key}: ${String(record[key])}`);
  }
  return [`${prefix}.message: ${String(value)}`];
}

function nestedCause(error: unknown): unknown {
  if (error instanceof Error && "cause" in error) return (error as { cause?: unknown }).cause;
  return undefined;
}

function errorCode(error: Error): string | undefined {
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
