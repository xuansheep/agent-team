import { fetch } from "undici";
import {
  ModelErrorKind,
  ModelProviderError,
  ModelRequest,
  ModelRetryPhase,
  ModelStreamEvent
} from "./types.js";

export type ApiKeyMode = "bearer" | "x-api-key";
export type ProviderNetworkError = ModelProviderError;

export type ProviderRetryConfig = {
  requestMaxRetries?: number;
  streamMaxRetries?: number;
  requestTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  calculateDelay?: (attempt: number) => number;
};

export type ProviderAttemptContext = {
  signal: AbortSignal;
  streamIdleTimeoutMs: number;
  markStreamStarted(): void;
  emit(event: ModelStreamEvent): void;
};

export const defaultProviderUserAgent = "claude-code/2.1.186";

const defaultRequestMaxRetries = 10;
const defaultStreamMaxRetries = 10;
const defaultRequestTimeoutMs = 600_000;
const defaultStreamIdleTimeoutMs = 90_000;
const retryBaseDelayMs = 500;
const retryMaxDelayMs = 32_000;
// Retry-After wins over our own backoff, but an hour-long (or 2^31-overflowing) value from a
// gateway must not park the process or wrap around into a busy loop.
const maxRetryAfterMs = 60_000;

export function buildApiKeyHeaders(apiKey: string, mode: ApiKeyMode): Record<string, string> {
  return mode === "x-api-key"
    ? { "x-api-key": apiKey }
    : { authorization: `Bearer ${apiKey}` };
}

export async function withProviderRetry<T>(input: {
  request: ModelRequest;
  endpoint: string;
  streaming: boolean;
  retry?: ProviderRetryConfig;
  onStreamEvent?: (event: ModelStreamEvent) => void;
  operation: (attempt: ProviderAttemptContext) => Promise<T>;
}): Promise<T> {
  const retry = resolvedRetryConfig(input.retry);
  let requestRetries = 0;
  let streamRetries = 0;

  for (;;) {
    throwIfAborted(input.request.signal);
    const controller = new AbortController();
    const unlink = linkAbortSignal(input.request.signal, controller);
    let streamStarted = false;
    let internalAbortReason: ModelProviderError | undefined;
    let discardedContentChars = 0;
    let discardedThinkingChars = 0;
    let requestTimer: ReturnType<typeof setTimeout> | undefined;

    const abortForTimeout = (phase: ModelRetryPhase, timeoutMs: number) => {
      internalAbortReason = new ModelProviderError(
        phase === "stream"
          ? `Provider stream was idle for ${timeoutMs}ms`
          : `Provider request timed out after ${timeoutMs}ms`,
        { errorKind: "timeout", phase, retryable: true }
      );
      controller.abort(internalAbortReason);
    };
    requestTimer = setTimeout(() => abortForTimeout("request", retry.requestTimeoutMs), retry.requestTimeoutMs);
    requestTimer.unref?.();

    const attempt: ProviderAttemptContext = {
      signal: controller.signal,
      streamIdleTimeoutMs: retry.streamIdleTimeoutMs,
      markStreamStarted() {
        if (streamStarted) return;
        streamStarted = true;
        if (requestTimer) clearTimeout(requestTimer);
        requestTimer = undefined;
      },
      emit(event) {
        if (event.type === "content_delta") discardedContentChars += event.text.length;
        else discardedThinkingChars += event.text.length;
        try {
          input.onStreamEvent?.(event);
        } catch (error) {
          throw new ModelProviderError("Provider stream callback failed", {
            errorKind: "unknown",
            phase: "stream",
            retryable: false,
            cause: error
          });
        }
      }
    };

    let failure: ModelProviderError | undefined;
    try {
      return await input.operation(attempt);
    } catch (error) {
      if (input.request.signal?.aborted) throw abortError(input.request.signal);
      failure = internalAbortReason ?? normalizeProviderError(error, streamStarted ? "stream" : "request", input.endpoint);
    } finally {
      if (requestTimer) clearTimeout(requestTimer);
      unlink();
    }

    // The failed attempt can still hold an open socket and a half-consumed response body. Once a
    // stream has started its idle timer is gone too, so without this abort every retry leaks a
    // connection that nothing will ever close.
    controller.abort(failure);

    if (!failure.retryable) throw failure;
    const phase = failure.phase;
    const maxRetries = phase === "stream" ? retry.streamMaxRetries : retry.requestMaxRetries;
    const completedRetries = phase === "stream" ? streamRetries : requestRetries;
    if (completedRetries >= maxRetries) throw retryLimitError(failure, maxRetries + 1);

    const retryAttempt = completedRetries + 1;
    if (phase === "stream") streamRetries = retryAttempt;
    else requestRetries = retryAttempt;
    const retryInMs = failure.retryAfterMs === undefined
      ? retry.calculateDelay(retryAttempt)
      : Math.min(failure.retryAfterMs, maxRetryAfterMs);
    const scheduledAt = new Date();
    await input.request.onRetry?.({
      phase,
      retryAttempt,
      maxRetries,
      retryInMs,
      scheduledAt: scheduledAt.toISOString(),
      retryAt: new Date(scheduledAt.getTime() + retryInMs).toISOString(),
      errorKind: failure.errorKind,
      status: failure.status,
      message: failure.message,
      detail: failure.detail,
      discardedContentChars,
      discardedThinkingChars
    });
    await delay(retryInMs, input.request.signal);
  }
}

export async function fetchProvider(endpoint: string, init: Parameters<typeof fetch>[1]): Promise<Awaited<ReturnType<typeof fetch>>> {
  try {
    return await fetch(endpoint, init);
  } catch (error) {
    if (isAbortError(error) || init?.signal?.aborted) throw error;
    throw new ModelProviderError(`Provider network request failed: ${errorMessage(error)}`, {
      errorKind: "network",
      phase: "request",
      retryable: true,
      detail: providerNetworkDetail(endpoint, error),
      cause: error
    });
  }
}

export function providerHttpError(status: number, body: string, headers?: { get(name: string): string | null }): ModelProviderError {
  const retryable = isRetryableHttpError(status, body);
  return new ModelProviderError(`Provider request failed ${status}: ${body}`, {
    errorKind: classifyProviderError(status, body),
    status,
    phase: "request",
    retryable,
    retryAfterMs: retryable ? parseRetryAfter(headers?.get("retry-after")) : undefined
  });
}

export function providerStreamError(message: string, input: { errorKind?: ModelErrorKind; status?: number; retryable?: boolean; detail?: string; retryAfterMs?: number; cause?: unknown } = {}): ModelProviderError {
  return new ModelProviderError(message, {
    errorKind: input.errorKind ?? "server",
    status: input.status,
    phase: "stream",
    retryable: input.retryable ?? true,
    retryAfterMs: input.retryAfterMs,
    detail: input.detail,
    cause: input.cause
  });
}

export function providerStreamApiError(message: string, input: { status?: number; marker?: string; detail: string }): ModelProviderError {
  const normalized = `${input.marker ?? ""} ${input.detail}`.toLowerCase();
  const errorKind = input.status !== undefined
    ? classifyProviderError(input.status, input.detail)
    : classifyStreamErrorMarker(normalized);
  const retryable = input.status !== undefined
    ? isRetryableHttpError(input.status, input.detail)
    : errorKind === "server" || errorKind === "rate_limit" || errorKind === "timeout" || errorKind === "network";
  return providerStreamError(message, {
    errorKind,
    status: input.status,
    retryable,
    detail: input.detail
  });
}

export function classifyProviderStatus(status: number): ModelErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 408) return "timeout";
  if (status === 429) return "rate_limit";
  if (status === 409 || status === 424 || status >= 500) return "server";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

export function classifyProviderError(status: number, body: string): ModelErrorKind {
  if (isContextLimitErrorBody(body)) return "context_limit";
  return classifyProviderStatus(status);
}

export async function consumeSseBlocks(
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(reason?: unknown): Promise<unknown> } },
  onData: (data: string) => boolean | void,
  options: { signal?: AbortSignal; idleTimeoutMs?: number } = {}
): Promise<boolean> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done = false;

  try {
    while (!done) {
      const chunk = await readSseChunk(reader, options);
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
  } finally {
    // Returning early on [DONE] leaves the body unread and the reader locked, so undici can never
    // hand the connection back to its pool.
    await Promise.resolve(reader.cancel?.()).catch(() => undefined);
  }
}

export function providerRetryDelay(attempt: number, random = Math.random): number {
  const baseDelay = Math.min(retryBaseDelayMs * 2 ** Math.max(0, attempt - 1), retryMaxDelayMs);
  return Math.round(baseDelay + random() * 0.25 * baseDelay);
}

function resolvedRetryConfig(input: ProviderRetryConfig | undefined): Required<ProviderRetryConfig> {
  return {
    requestMaxRetries: input?.requestMaxRetries ?? defaultRequestMaxRetries,
    streamMaxRetries: input?.streamMaxRetries ?? defaultStreamMaxRetries,
    requestTimeoutMs: input?.requestTimeoutMs ?? defaultRequestTimeoutMs,
    streamIdleTimeoutMs: input?.streamIdleTimeoutMs ?? defaultStreamIdleTimeoutMs,
    calculateDelay: input?.calculateDelay ?? providerRetryDelay
  };
}

function normalizeProviderError(error: unknown, phase: ModelRetryPhase, endpoint: string): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof SyntaxError) {
    return new ModelProviderError(`Provider returned invalid ${phase === "stream" ? "stream" : "JSON"} data: ${error.message}`, {
      errorKind: "server",
      phase,
      retryable: true,
      detail: providerNetworkDetail(endpoint, error),
      cause: error
    });
  }
  return new ModelProviderError(`Provider ${phase} failed: ${errorMessage(error)}`, {
    errorKind: "network",
    phase,
    retryable: true,
    detail: providerNetworkDetail(endpoint, error),
    cause: error
  });
}

function retryLimitError(error: ModelProviderError, attempts: number): ModelProviderError {
  const detail = [
    `attempts: ${attempts}`,
    error.detail
  ].filter(Boolean).join("\n");
  return new ModelProviderError(`Provider ${error.phase} failed after ${attempts} attempts: ${error.message}`, {
    errorKind: error.errorKind,
    status: error.status,
    phase: error.phase,
    retryable: false,
    retryAfterMs: error.retryAfterMs,
    detail,
    cause: error
  });
}

function isRetryableHttpError(status: number, body: string): boolean {
  return status === 408
    || status === 409
    || status === 429
    || status >= 500
    || (status === 424 && isDependencyUnavailableBody(body));
}

function isDependencyUnavailableBody(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as { error?: { type?: unknown; code?: unknown } };
    return parsed.error?.type === "service_dependency_unavailable"
      || parsed.error?.code === "service_dependency_unavailable";
  } catch {
    return false;
  }
}

function isContextLimitErrorBody(body: string): boolean {
  const normalized = body.toLowerCase();
  return [
    "prompt_too_long",
    "context_length_exceeded",
    "maximum context length",
    "context window exceeded",
    "input is too long",
    "input tokens exceed",
    "too many input tokens"
  ].some((marker) => normalized.includes(marker));
}

function classifyStreamErrorMarker(marker: string): ModelErrorKind {
  if (isContextLimitErrorBody(marker) || marker.includes("request_too_large")) return "context_limit";
  if (marker.includes("authentication") || marker.includes("unauthorized") || marker.includes("invalid_api_key")) return "auth";
  if (marker.includes("permission") || marker.includes("forbidden")) return "permission";
  if (marker.includes("rate_limit") || marker.includes("rate limit")) return "rate_limit";
  if (marker.includes("timeout")) return "timeout";
  if (marker.includes("bad_request") || marker.includes("invalid_request") || marker.includes("not_found")) return "invalid_request";
  return "server";
}

function parseRetryAfter(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}

function readSseChunk(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel?(reason?: unknown): Promise<unknown> },
  options: { signal?: AbortSignal; idleTimeoutMs?: number }
): Promise<{ done: boolean; value?: Uint8Array }> {
  const timeoutMs = options.idleTimeoutMs;
  if (!timeoutMs && !options.signal) return reader.read();
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(options.signal ? abortError(options.signal) : new Error("Provider request aborted")));
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs) {
      timer = setTimeout(() => {
        const error = providerStreamError(`Provider stream was idle for ${timeoutMs}ms`, { errorKind: "timeout" });
        void reader.cancel?.(error).catch(() => undefined);
        finish(() => reject(error));
      }, timeoutMs);
      timer.unref?.();
    }
    reader.read().then(
      (chunk) => finish(() => resolve(chunk)),
      (error) => finish(() => reject(error))
    );
  });
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

function providerNetworkDetail(endpoint: string, error: unknown): string {
  const cause = nestedCause(error) ?? error;
  return [
    `endpoint: ${endpoint}`,
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

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => controller.abort(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
