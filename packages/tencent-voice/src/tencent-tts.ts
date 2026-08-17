import type { TtsAdapter } from "../../voice-session/src/contracts.js";

import { AsyncQueue } from "./async-queue.js";
import type { TencentVoiceConfig } from "./config.js";
import { createDeferred } from "./deferred.js";
import {
  asTencentVoiceError,
  providerErrorFromCode,
  TencentVoiceProviderError,
} from "./errors.js";
import {
  buildTtsSignedRequest,
  type TencentSigningDependencies,
} from "./signing.js";
import {
  closeSocket,
  defaultTencentWebSocketFactory,
  messageData,
  toAudioBytes,
  type TencentWebSocket,
  type TencentWebSocketEventListener,
  type TencentWebSocketFactory,
} from "./websocket.js";

interface TtsResponse {
  readonly code: number;
  readonly final?: number;
}

export interface TencentTtsDependencies extends TencentSigningDependencies {
  readonly webSocketFactory?: TencentWebSocketFactory;
}

function parseTtsResponse(data: string): TtsResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new TencentVoiceProviderError("protocol_error");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("code" in parsed) ||
    typeof (parsed as { readonly code?: unknown }).code !== "number"
  ) {
    throw new TencentVoiceProviderError("protocol_error");
  }
  return parsed as TtsResponse;
}

export class TencentRealtimeTts implements TtsAdapter {
  readonly #webSocketFactory: TencentWebSocketFactory;

  public constructor(
    private readonly config: TencentVoiceConfig,
    private readonly dependencies: TencentTtsDependencies = {},
  ) {
    this.#webSocketFactory =
      dependencies.webSocketFactory ?? defaultTencentWebSocketFactory;
  }

  public async *synthesize(
    text: string,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<Uint8Array> {
    if (options.signal.aborted) {
      throw new TencentVoiceProviderError("cancelled");
    }
    if (text.length === 0) {
      throw new TencentVoiceProviderError("invalid_request");
    }

    const signed = buildTtsSignedRequest(this.config, text, this.dependencies);
    let socket: TencentWebSocket;
    try {
      socket = this.#webSocketFactory(signed.url);
      socket.binaryType = "arraybuffer";
    } catch (error: unknown) {
      throw asTencentVoiceError(error);
    }

    const queue = new AsyncQueue<unknown>();
    const opened = createDeferred<void>();
    let finalSeen = false;
    let audioChunks = 0;
    let stopped = false;

    const fail = (error: TencentVoiceProviderError) => {
      if (stopped) {
        return;
      }
      stopped = true;
      opened.reject(error);
      queue.fail(error);
      closeSocket(socket);
    };

    const onOpen: TencentWebSocketEventListener = () => opened.resolve();
    const onMessage: TencentWebSocketEventListener = (event) =>
      queue.push(messageData(event));
    const onError: TencentWebSocketEventListener = () =>
      fail(new TencentVoiceProviderError("provider_unavailable"));
    const onClose: TencentWebSocketEventListener = () => {
      if (!finalSeen && !stopped) {
        fail(new TencentVoiceProviderError("provider_unavailable"));
      } else {
        queue.close();
      }
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("message", onMessage);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);

    const onAbort = () => fail(new TencentVoiceProviderError("cancelled"));
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => fail(new TencentVoiceProviderError("timed_out")),
      this.config.timeoutMs,
    );

    try {
      await opened.promise;
      while (true) {
        const next = await queue.next(options.signal);
        if (next.done) {
          if (!finalSeen) {
            throw new TencentVoiceProviderError("provider_unavailable");
          }
          break;
        }

        const bytes = toAudioBytes(next.value);
        if (bytes !== undefined) {
          if (bytes.byteLength > 0) {
            audioChunks += 1;
            yield bytes;
          }
          continue;
        }

        if (typeof next.value !== "string") {
          throw new TencentVoiceProviderError("protocol_error");
        }
        const response = parseTtsResponse(next.value);
        if (response.code !== 0) {
          throw providerErrorFromCode("tts", response.code);
        }
        if (response.final === 1) {
          finalSeen = true;
          stopped = true;
          if (audioChunks === 0) {
            throw new TencentVoiceProviderError("tts_no_audio");
          }
          break;
        }
      }
    } catch (error: unknown) {
      throw asTencentVoiceError(error);
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      stopped = true;
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      closeSocket(socket);
    }
  }
}
