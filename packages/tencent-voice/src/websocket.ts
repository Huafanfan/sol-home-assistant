import { TencentVoiceProviderError } from "./errors.js";

export type WebSocketEventName = "open" | "message" | "error" | "close";
export type TencentWebSocketEventListener = (event: unknown) => void;

export interface TencentWebSocket {
  binaryType: string;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: WebSocketEventName,
    listener: TencentWebSocketEventListener,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(
    type: WebSocketEventName,
    listener: TencentWebSocketEventListener,
  ): void;
}

export type TencentWebSocketFactory = (sensitiveUrl: string) => TencentWebSocket;

export function defaultTencentWebSocketFactory(
  sensitiveUrl: string,
): TencentWebSocket {
  const constructor = (globalThis as unknown as {
    readonly WebSocket?: new (url: string) => TencentWebSocket;
  }).WebSocket;
  if (!constructor) {
    throw new TencentVoiceProviderError("provider_unavailable");
  }
  return new constructor(sensitiveUrl);
}

export function closeSocket(socket: TencentWebSocket): void {
  try {
    socket.close(1000, "closed");
  } catch {
    // Socket cleanup must never replace the original safe failure.
  }
}

export function messageData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { readonly data: unknown }).data;
  }
  return undefined;
}

export function toAudioBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data);
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data.slice(0));
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  }
  return undefined;
}

export function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new TencentVoiceProviderError("cancelled"));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new TencentVoiceProviderError("cancelled")),
      { once: true },
    );
  });
}

export function raceWithSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TencentVoiceProviderError("cancelled"));
      return;
    }
    const onAbort = () => reject(new TencentVoiceProviderError("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function delayWithSignal(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new TencentVoiceProviderError("cancelled"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new TencentVoiceProviderError("cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
