import {
  loadTencentVoiceConfig,
  TencentRealtimeAsr,
  TencentRealtimeTts,
  type TencentAsrDependencies,
  type TencentTtsDependencies,
  type TencentVoiceEnvironment,
} from "../../../../packages/tencent-voice/src/index.js";
import type {
  AsrAdapter,
  TtsAdapter,
} from "../../../../packages/voice-session/src/index.js";

export interface TencentVoiceGatewayAdapters {
  readonly asr: AsrAdapter;
  readonly tts: TtsAdapter;
}

export function createTencentVoiceGatewayAdapters(
  environment: TencentVoiceEnvironment = process.env,
  dependencies: {
    readonly asr?: TencentAsrDependencies;
    readonly tts?: TencentTtsDependencies;
  } = {},
): TencentVoiceGatewayAdapters {
  const config = loadTencentVoiceConfig(environment);
  return {
    asr: new TencentRealtimeAsr(config, dependencies.asr),
    tts: new TencentRealtimeTts(config, dependencies.tts),
  };
}
