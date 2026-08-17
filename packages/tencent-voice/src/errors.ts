export type TencentVoiceConfigurationErrorCode =
  | "app_id_missing"
  | "app_id_invalid"
  | "secret_id_missing"
  | "secret_id_invalid"
  | "secret_key_missing"
  | "secret_key_invalid"
  | "asr_profile_invalid"
  | "voice_type_missing"
  | "voice_type_invalid"
  | "timeout_invalid";

export class TencentVoiceConfigurationError extends Error {
  public constructor(public readonly code: TencentVoiceConfigurationErrorCode) {
    super(`Tencent voice configuration is invalid: ${code}`);
    this.name = "TencentVoiceConfigurationError";
  }
}

export type TencentVoiceProviderErrorCode =
  | "auth"
  | "quota_or_billing"
  | "rate_limited"
  | "invalid_request"
  | "timed_out"
  | "cancelled"
  | "provider_unavailable"
  | "protocol_error"
  | "asr_no_final"
  | "tts_no_audio";

/**
 * Provider failures deliberately retain only a stable category and numeric
 * provider code. They never retain response text, signed URLs, or credentials.
 */
export class TencentVoiceProviderError extends Error {
  public constructor(
    public readonly code: TencentVoiceProviderErrorCode,
    public readonly providerCode: number | undefined = undefined,
  ) {
    super(`Tencent voice request failed: ${code}`);
    this.name = "TencentVoiceProviderError";
  }
}

export function providerErrorFromCode(
  capability: "asr" | "tts",
  providerCode: number,
): TencentVoiceProviderError {
  if (capability === "asr") {
    if (providerCode === 4002) {
      return new TencentVoiceProviderError("auth", providerCode);
    }
    if (providerCode === 4003 || providerCode === 4004 || providerCode === 4005) {
      return new TencentVoiceProviderError("quota_or_billing", providerCode);
    }
    if (providerCode === 4006) {
      return new TencentVoiceProviderError("rate_limited", providerCode);
    }
    if (providerCode === 4008) {
      return new TencentVoiceProviderError("timed_out", providerCode);
    }
    if (providerCode === 4001) {
      return new TencentVoiceProviderError("invalid_request", providerCode);
    }
  } else {
    if (providerCode === 10003) {
      return new TencentVoiceProviderError("auth", providerCode);
    }
    if (providerCode === 10002) {
      return new TencentVoiceProviderError("rate_limited", providerCode);
    }
    if (providerCode === 10004) {
      return new TencentVoiceProviderError("timed_out", providerCode);
    }
    if (providerCode === 10001) {
      return new TencentVoiceProviderError("invalid_request", providerCode);
    }
  }

  return new TencentVoiceProviderError("protocol_error", providerCode);
}

export function asTencentVoiceError(error: unknown): TencentVoiceProviderError {
  if (error instanceof TencentVoiceProviderError) {
    return error;
  }
  return new TencentVoiceProviderError("provider_unavailable");
}
