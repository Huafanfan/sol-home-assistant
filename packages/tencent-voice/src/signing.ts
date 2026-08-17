import { createHmac, randomInt, randomUUID } from "node:crypto";

import type { TencentVoiceConfig } from "./config.js";

const ASR_HOST = "asr.cloud.tencent.com";
const ASR_PATH_PREFIX = "/asr/v2/";
const TTS_HOST = "tts.cloud.tencent.com";
const TTS_PATH = "/stream_ws";

export interface TencentSigningDependencies {
  readonly now?: () => number;
  readonly nonce?: () => number;
  readonly createId?: () => string;
}

export interface SignedTencentRequest {
  /** Sensitive: contains credential identifiers and a signature. Never log. */
  readonly url: string;
  /** Sensitive: contains a credential identifier. Exposed only for deterministic tests. */
  readonly canonicalSource: string;
  /** Sensitive signature. Exposed only for deterministic tests. */
  readonly signature: string;
}

function compareKeys(
  [left]: readonly [string, string],
  [right]: readonly [string, string],
): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalQuery(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .sort(compareKeys)
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function encodedQuery(parameters: Readonly<Record<string, string>>): string {
  return Object.entries(parameters)
    .sort(compareKeys)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function sign(source: string, secretKey: string): string {
  return createHmac("sha1", secretKey).update(source, "utf8").digest("base64");
}

function resolveDependencies(dependencies: TencentSigningDependencies): {
  readonly timestamp: number;
  readonly nonce: number;
  readonly id: string;
} {
  const timestamp = Math.floor((dependencies.now?.() ?? Date.now()) / 1_000);
  return {
    timestamp,
    nonce: dependencies.nonce?.() ?? randomInt(1, 2_147_483_647),
    id: dependencies.createId?.() ?? randomUUID(),
  };
}

export function buildAsrSignedRequest(
  config: TencentVoiceConfig,
  dependencies: TencentSigningDependencies = {},
): SignedTencentRequest {
  const resolved = resolveDependencies(dependencies);
  const parameters: Readonly<Record<string, string>> = {
    engine_model_type: config.asrEngineModelType,
    expired: String(resolved.timestamp + 60),
    filter_dirty: "1",
    filter_modal: "1",
    filter_punc: "1",
    needvad: "1",
    nonce: String(resolved.nonce),
    secretid: config.secretId,
    timestamp: String(resolved.timestamp),
    voice_format: "1",
    voice_id: resolved.id,
  };
  const path = `${ASR_PATH_PREFIX}${config.appId}`;
  const canonicalSource = `${ASR_HOST}${path}?${canonicalQuery(parameters)}`;
  const signature = sign(canonicalSource, config.secretKey);
  return {
    canonicalSource,
    signature,
    url: `wss://${ASR_HOST}${path}?${encodedQuery(parameters)}&signature=${encodeURIComponent(signature)}`,
  };
}

export function buildTtsSignedRequest(
  config: TencentVoiceConfig,
  text: string,
  dependencies: TencentSigningDependencies = {},
): SignedTencentRequest {
  const resolved = resolveDependencies(dependencies);
  const parameters: Readonly<Record<string, string>> = {
    Action: "TextToStreamAudioWS",
    AppId: config.appId,
    Codec: "pcm",
    EnableSubtitle: "False",
    Expired: String(resolved.timestamp + 60),
    SampleRate: "16000",
    SecretId: config.secretId,
    SessionId: resolved.id,
    Speed: "0",
    Text: text,
    Timestamp: String(resolved.timestamp),
    VoiceType: String(config.voiceType),
    Volume: "0",
  };
  const query = canonicalQuery(parameters);
  const canonicalSource = `GET${TTS_HOST}${TTS_PATH}?${query}`;
  const signature = sign(canonicalSource, config.secretKey);
  return {
    canonicalSource,
    signature,
    url: `wss://${TTS_HOST}${TTS_PATH}?${encodedQuery(parameters)}&Signature=${encodeURIComponent(signature)}`,
  };
}
