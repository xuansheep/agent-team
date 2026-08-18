import { WebSocket, type MessageEvent } from "undici";
import { ModelProviderError } from "./types.js";

const RESPONSES_WEBSOCKET_V2_BETA = "responses_websockets=2026-02-06";

export type ResponsesWebSocketChunk = {
  type?: string;
  response?: { id?: string };
  error?: { message?: string; type?: string; code?: string; status?: number };
};

export class ResponsesWebSocketV2Session {
  private socket?: WebSocket;
  private connectPromise?: Promise<WebSocket>;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly endpoint: string) {}

  request(input: {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    signal: AbortSignal;
    idleTimeoutMs: number;
    onOpen(): void;
    onChunk(chunk: ResponsesWebSocketChunk): void;
  }): Promise<void> {
    const operation = this.queue.then(() => this.requestNow(input));
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  close(): void {
    this.connectPromise = undefined;
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, "session closed");
  }

  private async requestNow(input: {
    body: Record<string, unknown>;
    headers: Record<string, string>;
    signal: AbortSignal;
    idleTimeoutMs: number;
    onOpen(): void;
    onChunk(chunk: ResponsesWebSocketChunk): void;
  }): Promise<void> {
    const socket = await this.open(input.headers, input.signal);
    input.onOpen();

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (idleTimer) clearTimeout(idleTimer);
        input.signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("message", onMessage);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          this.invalidate(socket);
          reject(error);
        } else {
          resolve();
        }
      };
      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          finish(new ModelProviderError(`Provider WebSocket stream was idle for ${input.idleTimeoutMs}ms`, {
            errorKind: "timeout",
            phase: "stream",
            retryable: true
          }));
        }, input.idleTimeoutMs);
        idleTimer.unref?.();
      };
      const onAbort = () => finish(input.signal.reason ?? new Error("Provider WebSocket request aborted"));
      const onError = (event: Event) => finish(new ModelProviderError("Provider WebSocket connection failed", {
        errorKind: "network",
        phase: "stream",
        retryable: true,
        detail: String((event as Event & { message?: string }).message ?? "websocket error")
      }));
      const onClose = (event: CloseEvent) => finish(new ModelProviderError(
        `Provider WebSocket closed before completion (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        { errorKind: "network", phase: "stream", retryable: true }
      ));
      const onMessage = (event: MessageEvent) => {
        try {
          resetIdleTimer();
          const chunk = JSON.parse(webSocketMessageText(event.data)) as ResponsesWebSocketChunk;
          input.onChunk(chunk);
          if (chunk.type === "response.completed" || chunk.type === "response.incomplete") {
            finish();
          }
        } catch (error) {
          finish(error);
        }
      };

      input.signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("message", onMessage);
      socket.addEventListener("error", onError);
      socket.addEventListener("close", onClose, { once: true });
      resetIdleTimer();

      try {
        socket.send(JSON.stringify({ type: "response.create", ...input.body, stream: true }));
      } catch (error) {
        finish(error);
      }
    });
  }

  private async open(headers: Record<string, string>, signal: AbortSignal): Promise<WebSocket> {
    if (this.socket?.readyState === WebSocket.OPEN) return this.socket;
    if (this.connectPromise) return this.connectPromise;

    const socket = new WebSocket(this.endpoint, {
      headers: {
        ...headers,
        "openai-beta": RESPONSES_WEBSOCKET_V2_BETA
      }
    });
    this.socket = socket;
    this.connectPromise = new Promise<WebSocket>((resolve, reject) => {
      const cleanup = () => {
        signal.removeEventListener("abort", onAbort);
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("error", onError);
        socket.removeEventListener("close", onClose);
      };
      const fail = (error: unknown) => {
        cleanup();
        this.invalidate(socket);
        reject(error);
      };
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onAbort = () => fail(signal.reason ?? new Error("Provider WebSocket connection aborted"));
      const onError = (event: Event) => fail(new ModelProviderError("Provider WebSocket handshake failed", {
        errorKind: "network",
        phase: "request",
        retryable: true,
        detail: String((event as Event & { message?: string }).message ?? "websocket error")
      }));
      const onClose = (event: CloseEvent) => fail(new ModelProviderError(
        `Provider WebSocket closed during handshake (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        { errorKind: "network", phase: "request", retryable: true }
      ));

      signal.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("error", onError, { once: true });
      socket.addEventListener("close", onClose, { once: true });
    }).finally(() => {
      this.connectPromise = undefined;
    });
    return this.connectPromise;
  }

  private invalidate(socket: WebSocket): void {
    if (this.socket === socket) this.socket = undefined;
    if (socket.readyState < WebSocket.CLOSING) socket.close();
  }
}

export function responsesWebSocketEndpoint(httpEndpoint: string): string {
  const endpoint = new URL(httpEndpoint);
  if (endpoint.protocol === "http:") endpoint.protocol = "ws:";
  else if (endpoint.protocol === "https:") endpoint.protocol = "wss:";
  else throw new Error(`Unsupported Responses API protocol: ${endpoint.protocol}`);
  return endpoint.toString();
}

function webSocketMessageText(data: unknown): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new SyntaxError("Provider WebSocket returned a non-text message");
}
