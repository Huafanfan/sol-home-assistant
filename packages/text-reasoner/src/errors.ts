export type TextReasonerProviderErrorCode =
  | "authentication_failed"
  | "rate_limited"
  | "provider_unavailable"
  | "protocol_unsupported"
  | "timed_out"
  | "request_rejected"
  | "network_failed";

/**
 * Error metadata is deliberately limited to a stable category and HTTP status.
 * It never stores response bodies, request payloads, endpoints, or credentials.
 */
export class TextReasonerProviderError extends Error {
  public constructor(
    public readonly code: TextReasonerProviderErrorCode,
    public readonly status: number | undefined = undefined,
  ) {
    super(`Text reasoner request failed: ${code}`);
    this.name = "TextReasonerProviderError";
  }
}

export function providerErrorForStatus(status: number): TextReasonerProviderError {
  if (status === 401 || status === 403) {
    return new TextReasonerProviderError("authentication_failed", status);
  }

  if (status === 429) {
    return new TextReasonerProviderError("rate_limited", status);
  }

  if (status >= 500 && status <= 599) {
    return new TextReasonerProviderError("provider_unavailable", status);
  }

  return new TextReasonerProviderError("request_rejected", status);
}
