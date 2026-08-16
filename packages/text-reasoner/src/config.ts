export type TextReasonerEnvironment = Readonly<
  Record<string, string | undefined>
>;

export type TextReasonerConfigurationCode =
  | "provider_invalid"
  | "base_url_missing"
  | "base_url_invalid"
  | "api_key_missing"
  | "api_key_invalid"
  | "model_missing"
  | "model_invalid"
  | "timeout_invalid"
  | "max_tokens_invalid";

/**
 * Configuration errors intentionally name a field or category only. They must
 * never retain or render a credential, endpoint, or caller-provided text.
 */
export class TextReasonerConfigurationError extends Error {
  public constructor(public readonly code: TextReasonerConfigurationCode) {
    super(`Text reasoner configuration is invalid: ${code}`);
    this.name = "TextReasonerConfigurationError";
  }
}

export class TextReasonerConfig {
  public readonly provider = "openai_compatible" as const;
  public readonly model: string;
  public readonly timeoutMs: number;
  public readonly maxTokens: number;

  readonly #baseUrl: URL;
  readonly #apiKey: string;

  public constructor(options: {
    readonly baseUrl: URL;
    readonly apiKey: string;
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxTokens: number;
  }) {
    this.#baseUrl = options.baseUrl;
    this.#apiKey = options.apiKey;
    this.model = options.model;
    this.timeoutMs = options.timeoutMs;
    this.maxTokens = options.maxTokens;
  }

  /** Returns a fresh URL so callers cannot mutate the hidden configured URL. */
  public chatCompletionsUrl(): URL {
    return endpointFor(this.#baseUrl, "chat/completions");
  }

  /** Returns a fresh URL so callers cannot mutate the hidden configured URL. */
  public modelsUrl(): URL {
    return endpointFor(this.#baseUrl, "models");
  }

  /** The credential is only materialized at the HTTP request boundary. */
  public authorizationHeader(): string {
    return `Bearer ${this.#apiKey}`;
  }

  /** Safe for structured diagnostics; deliberately omits URL and credential. */
  public toJSON(): {
    readonly provider: "openai_compatible";
    readonly model: string;
    readonly timeoutMs: number;
    readonly maxTokens: number;
  } {
    return {
      provider: this.provider,
      model: this.model,
      timeoutMs: this.timeoutMs,
      maxTokens: this.maxTokens,
    };
  }
}

export function loadTextReasonerConfig(
  environment: TextReasonerEnvironment = process.env,
): TextReasonerConfig {
  if (readRequired(environment, "TEXT_REASONER_PROVIDER", "provider_invalid") !== "openai_compatible") {
    throw new TextReasonerConfigurationError("provider_invalid");
  }

  const baseUrl = parseBaseUrl(
    readRequired(environment, "TEXT_REASONER_BASE_URL", "base_url_missing"),
  );
  const apiKey = readCredential(environment);
  const model = readModel(environment);

  return new TextReasonerConfig({
    baseUrl,
    apiKey,
    model,
    timeoutMs: readBoundedInteger(
      environment,
      "TEXT_REASONER_TIMEOUT_MS",
      30_000,
      1,
      120_000,
      "timeout_invalid",
    ),
    maxTokens: readBoundedInteger(
      environment,
      "TEXT_REASONER_MAX_TOKENS",
      256,
      1,
      1_024,
      "max_tokens_invalid",
    ),
  });
}

function readRequired(
  environment: TextReasonerEnvironment,
  name: string,
  missingCode: TextReasonerConfigurationCode,
): string {
  const value = environment[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TextReasonerConfigurationError(missingCode);
  }

  return value.trim();
}

function parseBaseUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TextReasonerConfigurationError("base_url_invalid");
  }

  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.protocol !== "https:" && !isLocalLoopbackHttp(parsed))
  ) {
    throw new TextReasonerConfigurationError("base_url_invalid");
  }

  parsed.search = "";
  parsed.hash = "";
  return parsed;
}

function readCredential(environment: TextReasonerEnvironment): string {
  const value = environment.TEXT_REASONER_API_KEY;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TextReasonerConfigurationError("api_key_missing");
  }

  if (value !== value.trim() || /[\r\n]/u.test(value)) {
    throw new TextReasonerConfigurationError("api_key_invalid");
  }

  return value;
}

function readModel(environment: TextReasonerEnvironment): string {
  const value = environment.TEXT_REASONER_MODEL;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TextReasonerConfigurationError("model_missing");
  }

  const model = value.trim();
  if (!/^[A-Za-z0-9._:-]+$/u.test(model)) {
    throw new TextReasonerConfigurationError("model_invalid");
  }

  return model;
}

function readBoundedInteger(
  environment: TextReasonerEnvironment,
  name: string,
  defaultValue: number,
  minimum: number,
  maximum: number,
  errorCode: TextReasonerConfigurationCode,
): number {
  const rawValue = environment[name];
  if (rawValue === undefined) {
    return defaultValue;
  }

  if (!/^[1-9][0-9]*$/u.test(rawValue)) {
    throw new TextReasonerConfigurationError(errorCode);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TextReasonerConfigurationError(errorCode);
  }

  return value;
}

function endpointFor(baseUrl: URL, suffix: "chat/completions" | "models"): URL {
  const endpoint = new URL(baseUrl);
  const path = endpoint.pathname.replace(/\/+$/u, "");
  const rootPath = path.endsWith("/chat/completions")
    ? path.slice(0, -"/chat/completions".length)
    : path;
  endpoint.pathname = `${rootPath}/${suffix}`.replace(/\/{2,}/gu, "/");
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function isLocalLoopbackHttp(url: URL): boolean {
  if (url.protocol !== "http:") {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}
