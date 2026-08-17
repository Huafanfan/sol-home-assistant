import type {
  AsrAdapter,
  AsrFinalResult,
  AsrRunOptions,
} from "../../voice-session/src/contracts.js";

import type { TencentVoiceConfig } from "./config.js";
import { createDeferred } from "./deferred.js";
import {
  asTencentVoiceError,
  providerErrorFromCode,
  TencentVoiceProviderError,
} from "./errors.js";
import {
  buildAsrSignedRequest,
  type TencentSigningDependencies,
} from "./signing.js";
import {
  closeSocket,
  defaultTencentWebSocketFactory,
  delayWithSignal,
  messageData,
  raceWithSignal,
  type TencentWebSocket,
  type TencentWebSocketEventListener,
  type TencentWebSocketFactory,
} from "./websocket.js";

const PCM_BYTES_PER_200_MS = 6_400;
const PCM_BYTES_PER_MILLISECOND = 32;

interface AsrResponse {
  readonly code: number;
  readonly final?: number;
  readonly result?: {
    readonly slice_type?: number;
    readonly index?: number;
    readonly voice_text_str?: string;
  };
}

export interface TencentAsrDependencies extends TencentSigningDependencies {
  readonly webSocketFactory?: TencentWebSocketFactory;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

function parseAsrResponse(data: unknown): AsrResponse {
  if (typeof data !== "string") {
    throw new TencentVoiceProviderError("protocol_error");
  }
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
  return parsed as AsrResponse;
}

function safeSend(socket: TencentWebSocket, data: string | Uint8Array): void {
  try {
    socket.send(data);
  } catch {
    throw new TencentVoiceProviderError("protocol_error");
  }
}

export class TencentRealtimeAsr implements AsrAdapter {
  readonly #webSocketFactory: TencentWebSocketFactory;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  public constructor(
    private readonly config: TencentVoiceConfig,
    private readonly dependencies: TencentAsrDependencies = {},
  ) {
    this.#webSocketFactory =
      dependencies.webSocketFactory ?? defaultTencentWebSocketFactory;
    this.#sleep = dependencies.sleep ?? delayWithSignal;
  }

  public async transcribe(
    audio: AsyncIterable<Uint8Array>,
    options: AsrRunOptions,
  ): Promise<AsrFinalResult> {
    if (options.signal.aborted) {
      throw new TencentVoiceProviderError("cancelled");
    }

    const signed = buildAsrSignedRequest(this.config, this.dependencies);
    let socket: TencentWebSocket;
    try {
      socket = this.#webSocketFactory(signed.url);
      socket.binaryType = "arraybuffer";
    } catch (error: unknown) {
      throw asTencentVoiceError(error);
    }

    const internal = new AbortController();
    const opened = createDeferred<void>();
    const handshake = createDeferred<void>();
    const result = createDeferred<AsrFinalResult>();
    const finalSentences = new Map<number, string>();
    let settled = false;

    const fail = (error: TencentVoiceProviderError) => {
      if (settled) {
        return;
      }
      settled = true;
      internal.abort();
      opened.reject(error);
      handshake.reject(error);
      result.reject(error);
      closeSocket(socket);
    };

    const onOpen: TencentWebSocketEventListener = () => opened.resolve();
    const onError: TencentWebSocketEventListener = () =>
      fail(new TencentVoiceProviderError("provider_unavailable"));
    const onClose: TencentWebSocketEventListener = () => {
      if (!settled) {
        fail(new TencentVoiceProviderError("provider_unavailable"));
      }
    };
    const onMessage: TencentWebSocketEventListener = (event) => {
      if (settled) {
        return;
      }
      try {
        const response = parseAsrResponse(messageData(event));
        if (response.code !== 0) {
          fail(providerErrorFromCode("asr", response.code));
          return;
        }
        handshake.resolve();
        const providerResult = response.result;
        const transcript = providerResult?.voice_text_str;
        if (typeof transcript === "string" && transcript.length > 0) {
          options.onPartialTranscript({ characterCount: transcript.length });
          if (providerResult?.slice_type === 2) {
            finalSentences.set(providerResult.index ?? finalSentences.size, transcript);
          }
        }
        if (response.final === 1) {
          const finalTranscript = [...finalSentences.entries()]
            .sort(([left], [right]) => left - right)
            .map(([, sentence]) => sentence)
            .join("");
          if (finalTranscript.length === 0) {
            fail(new TencentVoiceProviderError("asr_no_final"));
            return;
          }
          settled = true;
          result.resolve({ finalTranscript });
          closeSocket(socket);
        }
      } catch (error: unknown) {
        fail(asTencentVoiceError(error));
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

    const sendAudio = async () => {
      await opened.promise;
      await handshake.promise;
      const iterator = audio[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await raceWithSignal(iterator.next(), internal.signal);
          if (next.done) {
            break;
          }
          const frame = next.value;
          for (let offset = 0; offset < frame.byteLength; offset += PCM_BYTES_PER_200_MS) {
            const chunk = frame.slice(offset, offset + PCM_BYTES_PER_200_MS);
            if (chunk.byteLength === 0) {
              continue;
            }
            safeSend(socket, chunk);
            await this.#sleep(
              Math.ceil(chunk.byteLength / PCM_BYTES_PER_MILLISECOND),
              internal.signal,
            );
          }
        }
        safeSend(socket, JSON.stringify({ type: "end" }));
      } finally {
        await iterator.return?.();
      }
    };

    const sender = sendAudio().catch((error: unknown) => {
      if (!settled) {
        fail(asTencentVoiceError(error));
      }
    });

    try {
      const finalResult = await result.promise;
      await sender;
      return finalResult;
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      internal.abort();
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      closeSocket(socket);
    }
  }
}
