import { pathToFileURL } from "node:url";

import {
  buildAsrSignedRequest,
  buildTtsSignedRequest,
  loadTencentVoiceConfig,
  TencentRealtimeAsr,
  TencentRealtimeTts,
  TencentVoiceConfigurationError,
  TencentVoiceProviderError,
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
  readonly ttsCharacterCount?: number;
  readonly ttsAudioChunkCount?: number;
  readonly ttsAudioByteCount?: number;
  readonly ttsAudioDurationMs?: number;
  readonly asrFinalPresent?: boolean;
  readonly asrFinalCharacterCount?: number;
}

export interface TencentVoiceProbeOptions {
  readonly environment?: TencentVoiceEnvironment;
  readonly confirmBillable?: boolean;
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

export async function runTencentVoiceProbe(
  options: TencentVoiceProbeOptions = {},
): Promise<TencentVoiceProbeReport> {
  const config = loadTencentVoiceConfig(options.environment ?? process.env);

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
  try {
    for await (const chunk of tts.synthesize(PROBE_TEXT, { signal })) {
      byteCount += chunk.byteLength;
      if (byteCount > MAX_PCM_BYTES) {
        throw new TencentVoiceProviderError("invalid_request");
      }
      chunks.push(chunk);
    }
  } catch (error: unknown) {
    throw probeError("tts", error);
  }

  let result: Awaited<ReturnType<TencentRealtimeAsr["transcribe"]>>;
  try {
    result = await asr.transcribe(audioChunks(chunks), {
      signal,
      onPartialTranscript: () => undefined,
    });
  } catch (error: unknown) {
    throw probeError("asr", error);
  }

  return {
    mode: "controlled-live",
    configValid: true,
    signingSelfCheck: true,
    networkAttempted: true,
    ttsCharacterCount: PROBE_TEXT.length,
    ttsAudioChunkCount: chunks.length,
    ttsAudioByteCount: byteCount,
    ttsAudioDurationMs: Math.ceil(byteCount / 32),
    asrFinalPresent: result.finalTranscript.length > 0,
    asrFinalCharacterCount: result.finalTranscript.length,
  };
}

async function main(): Promise<void> {
  try {
    const report = await runTencentVoiceProbe({
      confirmBillable: process.argv.includes("--confirm-billable"),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
