import { pathToFileURL } from "node:url";

import {
  buildAsrSignedRequest,
  buildTtsSignedRequest,
  loadTencentVoiceConfig,
  TencentRealtimeAsr,
  TencentRealtimeTts,
  TencentVoiceConfigurationError,
  TencentVoiceProviderError,
  type TencentVoiceConfig,
  type TencentAsrDependencies,
  type TencentTtsDependencies,
  type TencentVoiceEnvironment,
} from "../packages/tencent-voice/src/index.js";

const PROBE_TEXT = "你好，这是语音测试。";
const MAX_PCM_BYTES = 320_000;

export interface TencentVoiceProbeReport {
  readonly mode: "offline" | "controlled-live";
  readonly configValid: true;
  readonly signingSelfCheck: true;
  readonly networkAttempted: boolean;
  readonly ttsFirstAudioLatencyMs?: number;
  readonly ttsCompletionLatencyMs?: number;
  readonly ttsCharacterCount?: number;
  readonly ttsAudioChunkCount?: number;
  readonly ttsAudioByteCount?: number;
  readonly ttsAudioDurationMs?: number;
  readonly asrFirstPartialLatencyMs?: number;
  readonly asrFinalLatencyMs?: number;
  readonly asrFinalPresent?: boolean;
  readonly asrFinalCharacterCount?: number;
  readonly ttsConnectionAttemptCount?: number;
  readonly asrConnectionAttemptCount?: number;
  readonly retryCount?: number;
  readonly cancellationAttempted?: boolean;
  readonly ttsLocalCancellationObserved?: boolean;
  readonly ttsPostCancellationAudioChunkCount?: number;
  readonly asrLocalCancellationObserved?: boolean;
  readonly asrPostCancellationPartialCount?: number;
  readonly asrPostCancellationFinalCount?: number;
}

export interface TencentVoiceProbeOptions {
  readonly environment?: TencentVoiceEnvironment;
  readonly confirmBillable?: boolean;
  readonly confirmCancellation?: boolean;
  /** Monotonic probe metrics clock; signing dependencies keep their own `now`. */
  readonly monotonicNow?: () => number;
  readonly asrDependencies?: TencentAsrDependencies;
  readonly ttsDependencies?: TencentTtsDependencies;
}

export type TencentVoiceProbeStage = "tts" | "asr";

/** Safe diagnostic envelope: never retains provider message, URL, or content. */
export class TencentVoiceProbeError extends Error {
  public constructor(
    public readonly stage: TencentVoiceProbeStage,
    public readonly code: TencentVoiceProviderError["code"] | "unknown_error",
    public readonly providerCode: number | undefined = undefined,
  ) {
    super(`Tencent voice probe failed: ${stage}:${code}`);
    this.name = "TencentVoiceProbeError";
  }
}

function probeError(
  stage: TencentVoiceProbeStage,
  error: unknown,
): TencentVoiceProbeError {
  if (error instanceof TencentVoiceProviderError) {
    return new TencentVoiceProbeError(stage, error.code, error.providerCode);
  }
  return new TencentVoiceProbeError(stage, "unknown_error");
}

async function* audioChunks(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

function elapsedMilliseconds(
  clock: () => number,
  startedAt: number,
): number {
  const elapsed = clock() - startedAt;
  return Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
}

interface TtsCancellationMetrics {
  readonly observed: boolean;
  readonly postCancellationAudioChunkCount: number;
}

interface AsrCancellationMetrics {
  readonly observed: boolean;
  readonly postCancellationPartialCount: number;
  readonly postCancellationFinalCount: number;
}

async function runTtsCancellationProbe(
  config: TencentVoiceConfig,
  dependencies: TencentTtsDependencies | undefined,
): Promise<TtsCancellationMetrics> {
  const adapter = new TencentRealtimeTts(config, dependencies);
  const controller = new AbortController();
  let cancellationRequested = false;
  let observed = false;
  let postCancellationAudioChunkCount = 0;

  try {
    for await (const _chunk of adapter.synthesize(PROBE_TEXT, {
      signal: controller.signal,
    })) {
      if (cancellationRequested) {
        postCancellationAudioChunkCount += 1;
        continue;
      }
      // Abort only after the first non-empty audio chunk has been delivered.
      cancellationRequested = true;
      controller.abort();
    }
  } catch (error: unknown) {
    if (
      error instanceof TencentVoiceProviderError &&
      error.code === "cancelled"
    ) {
      observed = true;
    } else {
      throw probeError("tts", error);
    }
  }

  return {
    observed,
    postCancellationAudioChunkCount,
  };
}

async function runAsrCancellationProbe(
  config: TencentVoiceConfig,
  dependencies: TencentAsrDependencies | undefined,
  pcm: readonly Uint8Array[],
): Promise<AsrCancellationMetrics> {
  const controller = new AbortController();
  let audioPulled = false;
  let cancellationRequested = false;
  let observed = false;
  let postCancellationPartialCount = 0;
  let postCancellationFinalCount = 0;

  async function* independentPcm(): AsyncIterable<Uint8Array> {
    for (const chunk of pcm) {
      audioPulled = true;
      yield new Uint8Array(chunk);
    }
  }

  // The adapter invokes sleep only after the handshake and after pulling and
  // sending the first PCM frame. Aborting from this injected sleep keeps the
  // cancellation probe independent of the completed success connection.
  const cancellationDependencies: TencentAsrDependencies = {
    ...dependencies,
    sleep: async () => {
      if (!audioPulled) {
        throw new TencentVoiceProviderError("protocol_error");
      }
      cancellationRequested = true;
      controller.abort();
    },
  };
  const adapter = new TencentRealtimeAsr(config, cancellationDependencies);

  try {
    const result = await adapter.transcribe(independentPcm(), {
      signal: controller.signal,
      onPartialTranscript: () => {
        if (cancellationRequested) {
          postCancellationPartialCount += 1;
        }
      },
    });
    if (cancellationRequested) {
      postCancellationFinalCount += 1;
    }
    void result;
  } catch (error: unknown) {
    if (
      error instanceof TencentVoiceProviderError &&
      error.code === "cancelled"
    ) {
      observed = true;
    } else {
      throw probeError("asr", error);
    }
  }

  return {
    observed,
    postCancellationPartialCount,
    postCancellationFinalCount,
  };
}

export async function runTencentVoiceProbe(
  options: TencentVoiceProbeOptions = {},
): Promise<TencentVoiceProbeReport> {
  const config = loadTencentVoiceConfig(options.environment ?? process.env);
  const monotonicNow = options.monotonicNow ?? (() => performance.now());

  // Build both signed request shapes as an offline protocol self-check. The
  // resulting sensitive strings stay in this stack frame and are never logged.
  const asrRequest = buildAsrSignedRequest(config, options.asrDependencies);
  const ttsRequest = buildTtsSignedRequest(
    config,
    PROBE_TEXT,
    options.ttsDependencies,
  );
  if (
    !asrRequest.url.startsWith("wss://asr.cloud.tencent.com/asr/v2/") ||
    !ttsRequest.url.startsWith("wss://tts.cloud.tencent.com/stream_ws?")
  ) {
    throw new TencentVoiceProviderError("protocol_error");
  }

  if (options.confirmBillable !== true) {
    return {
      mode: "offline",
      configValid: true,
      signingSelfCheck: true,
      networkAttempted: false,
    };
  }

  const tts = new TencentRealtimeTts(config, options.ttsDependencies);
  const asr = new TencentRealtimeAsr(config, options.asrDependencies);
  const signal = new AbortController().signal;
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  const ttsStartedAt = monotonicNow();
  let ttsFirstAudioLatencyMs: number | undefined;
  try {
    for await (const chunk of tts.synthesize(PROBE_TEXT, { signal })) {
      if (ttsFirstAudioLatencyMs === undefined) {
        ttsFirstAudioLatencyMs = elapsedMilliseconds(
          monotonicNow,
          ttsStartedAt,
        );
      }
      byteCount += chunk.byteLength;
      if (byteCount > MAX_PCM_BYTES) {
        throw new TencentVoiceProviderError("invalid_request");
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    throw probeError("tts", error);
  }
  const ttsCompletionLatencyMs = elapsedMilliseconds(
    monotonicNow,
    ttsStartedAt,
  );

  let result: Awaited<ReturnType<TencentRealtimeAsr["transcribe"]>>;
  const asrStartedAt = monotonicNow();
  let asrFirstPartialLatencyMs: number | undefined;
  try {
    result = await asr.transcribe(audioChunks(chunks), {
      signal,
      onPartialTranscript: () => {
        if (asrFirstPartialLatencyMs === undefined) {
          asrFirstPartialLatencyMs = elapsedMilliseconds(
            monotonicNow,
            asrStartedAt,
          );
        }
      },
    });
  } catch (error: unknown) {
    throw probeError("asr", error);
  }
  const asrFinalLatencyMs = elapsedMilliseconds(monotonicNow, asrStartedAt);

  let cancellationReport: Pick<
    TencentVoiceProbeReport,
    | "ttsLocalCancellationObserved"
    | "ttsPostCancellationAudioChunkCount"
    | "asrLocalCancellationObserved"
    | "asrPostCancellationPartialCount"
    | "asrPostCancellationFinalCount"
  > = {};
  if (options.confirmCancellation === true) {
    // Each cancellation probe receives a fresh adapter and therefore a fresh
    // WebSocket connection. No completed success connection is reused.
    const ttsCancellation = await runTtsCancellationProbe(
      config,
      options.ttsDependencies,
    );
    const asrCancellation = await runAsrCancellationProbe(
      config,
      options.asrDependencies,
      chunks,
    );
    if (
      !ttsCancellation.observed ||
      ttsCancellation.postCancellationAudioChunkCount !== 0
    ) {
      throw new TencentVoiceProbeError("tts", "protocol_error");
    }
    if (
      !asrCancellation.observed ||
      asrCancellation.postCancellationPartialCount !== 0 ||
      asrCancellation.postCancellationFinalCount !== 0
    ) {
      throw new TencentVoiceProbeError("asr", "protocol_error");
    }
    cancellationReport = {
      ttsLocalCancellationObserved: ttsCancellation.observed,
      ttsPostCancellationAudioChunkCount:
        ttsCancellation.postCancellationAudioChunkCount,
      asrLocalCancellationObserved: asrCancellation.observed,
      asrPostCancellationPartialCount:
        asrCancellation.postCancellationPartialCount,
      asrPostCancellationFinalCount: asrCancellation.postCancellationFinalCount,
    };
  }

  return {
    mode: "controlled-live",
    configValid: true,
    signingSelfCheck: true,
    networkAttempted: true,
    ...(ttsFirstAudioLatencyMs === undefined ? {} : { ttsFirstAudioLatencyMs }),
    ttsCompletionLatencyMs,
    ttsCharacterCount: PROBE_TEXT.length,
    ttsAudioChunkCount: chunks.length,
    ttsAudioByteCount: byteCount,
    ttsAudioDurationMs: Math.ceil(byteCount / 32),
    ...(asrFirstPartialLatencyMs === undefined
      ? {}
      : { asrFirstPartialLatencyMs }),
    asrFinalLatencyMs,
    asrFinalPresent: result.finalTranscript.length > 0,
    asrFinalCharacterCount: result.finalTranscript.length,
    ttsConnectionAttemptCount: options.confirmCancellation === true ? 2 : 1,
    asrConnectionAttemptCount: options.confirmCancellation === true ? 2 : 1,
    retryCount: 0,
    cancellationAttempted: options.confirmCancellation === true,
    ...cancellationReport,
  };
}

async function main(): Promise<void> {
  try {
    const report = await runTencentVoiceProbe({
      confirmBillable: process.argv.includes("--confirm-billable"),
      confirmCancellation: process.argv.includes("--confirm-cancellation"),
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error: unknown) {
    const safeFailure =
      error instanceof TencentVoiceProbeError
        ? {
            ok: false,
            stage: error.stage,
            code: error.code,
            providerCode: error.providerCode,
          }
        : {
            ok: false,
            code:
              error instanceof TencentVoiceConfigurationError ||
              error instanceof TencentVoiceProviderError
                ? error.code
                : "unknown_error",
          };
    process.stderr.write(`${JSON.stringify(safeFailure)}\n`);
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
