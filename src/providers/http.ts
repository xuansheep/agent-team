import { fetch } from "undici";
import { ModelErrorKind, ModelProviderError } from "./types.js";

export type ApiKeyMode = "bearer" | "x-api-key";
export type ProviderNetworkError = ModelProviderError;

export const defaultProviderUserAgent = "claude-code/2.1.186";

const providerNetworkAttempts = 5;
const providerDependencyAttempts = 3;
const providerDependencyRetryDelays = [200, 400] as const;

export function buildApiKeyHeaders(apiKey: string, mode: ApiKeyMode): Record<string, string> {
  return mode === "x-api-key"
    ? { "x-api-key": apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

export async function fetchProvider(endpoint: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
  const signal = init?.signal;
  for (let attempt = 1; attempt <= providerDependencyAttempts; attempt += 1) {
    const response = await fetchProviderNetwork(endpoint, init);
    const retry = attempt < providerDependencyAttempts && await isDependencyUnavailable(response);
    if (!retry) return response;
    await response.body?.cancel();
    await delay(providerDependencyRetryDelays[attempt - 1]!, signal);
  }
  throw new Error("Provider dependency retry loop completed without a response");
}

async function fetchProviderNetwork(endpoint: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
  const signal = init?.signal;
  let lastError: unknown;
  for (let attempt = 1; attempt <= providerNetworkAttempts; attempt += 1) {
    throwIfAborted(signal);
    try {
      return await fetch(endpoint, init);
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      lastError = error;
      if (attempt === providerNetworkAttempts) break;
      await delay(attempt * 25, signal);
    }
  }

  const message = errorMessage(lastError);
  throw new ModelProviderError(`Provider network request failed after ${providerNetworkAttempts} attempts: ${message}`, {
    errorKind: "network",
    detail: providerNetworkDetail(endpoint, providerNetworkAttempts, lastError),
    cause: lastError
  });
}

async function isDependencyUnavailable(response: Awaited<ReturnType<typeof fetch>>): Promise<boolean> {
  if (response.status !== 424) return false;
  try {
    const body = await response.clone().json() as { error?: { type?: unknown; code?: unknown } };
    return body.error?.type === "service_dependency_unavailable"
      || body.error?.code === "service_dependency_unavailable";
  } catch {
    return false;
  }
}

export function providerHttpError(status: number, body: string): ModelProviderError {
  return new ModelProviderError(`Provider request failed ${status}: ${body}`, { errorKind: classifyProviderStatus(status), status });
}

export function classifyProviderStatus(status: number): ModelErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 429) return "rate_limit";
  if (status === 424) return "server";
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

    buffer = normalizeSseLineEndings(buffer, done);
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

function normalizeSseLineEndings(value: string, flush: boolean): string {
  const hasPendingCarriageReturn = !flush && value.endsWith("\r");
  const stable = hasPendingCarriageReturn ? value.slice(0, -1) : value;
  const normalized = stable.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return hasPendingCarriageReturn ? normalized + "\r" : normalized;
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

export function isAbortError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return true;
  if (error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError") return true;
  return false;
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (!signal?.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Provider request aborted");
  error.name = "AbortError";
  return error;
}

function delay(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal ? abortError(signal) : new Error("Provider request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
