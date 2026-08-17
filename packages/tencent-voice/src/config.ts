import { TencentVoiceConfigurationError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;

export interface TencentVoiceConfig {
  readonly appId: string;
  readonly secretId: string;
  readonly secretKey: string;
  readonly asrProfile: "standard";
  readonly asrEngineModelType: "16k_zh";
  readonly voiceType: number;
  readonly timeoutMs: number;
}

export type TencentVoiceEnvironment = Readonly<Record<string, string | undefined>>;

function required(
  environment: TencentVoiceEnvironment,
  name: string,
  missingCode:
    | "app_id_missing"
    | "secret_id_missing"
    | "secret_key_missing"
    | "voice_type_missing",
): string {
  const value = environment[name];
  if (value === undefined || value.trim() === "") {
    throw new TencentVoiceConfigurationError(missingCode);
  }
  return value;
}

function hasUnsafeWhitespace(value: string): boolean {
  return /\s/.test(value);
}

export function loadTencentVoiceConfig(
  environment: TencentVoiceEnvironment = process.env,
): TencentVoiceConfig {
  const appId = required(environment, "TENCENT_CLOUD_APP_ID", "app_id_missing");
  if (!/^[1-9]\d*$/.test(appId)) {
    throw new TencentVoiceConfigurationError("app_id_invalid");
  }

  const secretId = required(
    environment,
    "TENCENT_CLOUD_SECRET_ID",
    "secret_id_missing",
  );
  if (hasUnsafeWhitespace(secretId)) {
    throw new TencentVoiceConfigurationError("secret_id_invalid");
  }

  const secretKey = required(
    environment,
    "TENCENT_CLOUD_SECRET_KEY",
    "secret_key_missing",
  );
  if (hasUnsafeWhitespace(secretKey)) {
    throw new TencentVoiceConfigurationError("secret_key_invalid");
  }

  const asrProfile = environment.TENCENT_ASR_PROFILE?.trim() ?? "standard";
  if (asrProfile !== "standard") {
    throw new TencentVoiceConfigurationError("asr_profile_invalid");
  }

  const voiceTypeRaw = required(
    environment,
    "TENCENT_TTS_VOICE_TYPE",
    "voice_type_missing",
  );
  if (!/^[1-9]\d*$/.test(voiceTypeRaw)) {
    throw new TencentVoiceConfigurationError("voice_type_invalid");
  }
  const voiceType = Number(voiceTypeRaw);
  if (!Number.isSafeInteger(voiceType)) {
    throw new TencentVoiceConfigurationError("voice_type_invalid");
  }

  const timeoutRaw = environment.TENCENT_VOICE_TIMEOUT_MS?.trim();
  const timeoutMs = timeoutRaw === undefined || timeoutRaw === ""
    ? DEFAULT_TIMEOUT_MS
    : Number(timeoutRaw);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < MIN_TIMEOUT_MS ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new TencentVoiceConfigurationError("timeout_invalid");
  }

  return {
    appId,
    secretId,
    secretKey,
    asrProfile,
    asrEngineModelType: "16k_zh",
    voiceType,
    timeoutMs,
  };
}
