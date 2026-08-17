import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import {
  createTencentVoiceGatewayAdapters,
  VoiceGateway,
} from "../apps/voice-gateway/src/index.js";
import {
  buildAsrSignedRequest,
  buildTtsSignedRequest,
  loadTencentVoiceConfig,
  TencentRealtimeAsr,
  TencentRealtimeTts,
  TencentVoiceConfigurationError,
  TencentVoiceProviderError,
  type TencentVoiceConfig,
  type TencentWebSocket,
  type TencentWebSocketEventListener,
  type WebSocketEventName,
} from "../packages/tencent-voice/src/index.js";
import {
  RecordingPlayback,
  StaticReasoner,
  StaticRouter,
} from "../packages/voice-session/src/index.js";
import { runTencentVoiceProbe } from "../scripts/probe-tencent-voice.js";

const environment = (
  overrides: Readonly<Record<string, string | undefined>> = {},
): Readonly<Record<string, string | undefined>> => ({
  TENCENT_CLOUD_APP_ID: "1234567890",
  TENCENT_CLOUD_SECRET_ID: "TEST_SECRET_ID",
  TENCENT_CLOUD_SECRET_KEY: "TEST_SECRET_KEY",
  TENCENT_ASR_PROFILE: "standard",
  TENCENT_TTS_VOICE_TYPE: "101001",
  TENCENT_VOICE_TIMEOUT_MS: "30000",
  ...overrides,
});

const config = (
  overrides: Partial<TencentVoiceConfig> = {},
): TencentVoiceConfig => ({
  appId: "1234567890",
  secretId: "TEST_SECRET_ID",
  secretKey: "TEST_SECRET_KEY",
  asrProfile: "standard",
  asrEngineModelType: "16k_zh",
  voiceType: 101001,
  timeoutMs: 30_000,
  ...overrides,
});

class FakeWebSocket implements TencentWebSocket {
  public binaryType = "blob";
  public readonly sent: Array<string | Uint8Array> = [];
  public closed = false;
  public onSend: ((data: string | Uint8Array) => void) | undefined;

  readonly #listeners = new Map<
    WebSocketEventName,
    Set<TencentWebSocketEventListener>
  >();

  public addEventListener(
    type: WebSocketEventName,
    listener: TencentWebSocketEventListener,
  ): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  public removeEventListener(
    type: WebSocketEventName,
    listener: TencentWebSocketEventListener,
  ): void {
    this.#listeners.get(type)?.delete(listener);
  }

  public send(data: string | Uint8Array): void {
    const saved = typeof data === "string" ? data : new Uint8Array(data);
    this.sent.push(saved);
    this.onSend?.(saved);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emit("close", {});
  }

  public emit(type: WebSocketEventName, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function asrFactory(options: {
  readonly finalText?: string;
  readonly providerCode?: number;
  readonly omitFinalSentence?: boolean;
  readonly neverOpen?: boolean;
} = {}): {
  readonly factory: (url: string) => TencentWebSocket;
  readonly sockets: FakeWebSocket[];
  readonly urls: string[];
} {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  return {
    sockets,
    urls,
    factory: (url) => {
      urls.push(url);
      const socket = new FakeWebSocket();
      sockets.push(socket);
      if (!options.neverOpen) {
        queueMicrotask(() => {
          socket.emit("open", {});
          socket.emit("message", {
            data: JSON.stringify({
              code: options.providerCode ?? 0,
              message: "UNSAFE_PROVIDER_MESSAGE",
            }),
          });
        });
      }
      socket.onSend = (data) => {
        if (data !== JSON.stringify({ type: "end" })) {
          return;
        }
        socket.emit("message", {
          data: JSON.stringify({
            code: 0,
            result: {
              slice_type: 0,
              index: 0,
              voice_text_str: "局部",
            },
          }),
        });
        if (!options.omitFinalSentence) {
          socket.emit("message", {
            data: JSON.stringify({
              code: 0,
              result: {
                slice_type: 2,
                index: 0,
                voice_text_str: options.finalText ?? "最终结果",
              },
            }),
          });
        }
        socket.emit("message", {
          data: JSON.stringify({ code: 0, final: 1 }),
        });
      };
      return socket;
    },
  };
}

function ttsFactory(options: {
  readonly providerCode?: number;
  readonly empty?: boolean;
  readonly neverOpen?: boolean;
} = {}): {
  readonly factory: (url: string) => TencentWebSocket;
  readonly sockets: FakeWebSocket[];
  readonly urls: string[];
} {
  const sockets: FakeWebSocket[] = [];
  const urls: string[] = [];
  return {
    sockets,
    urls,
    factory: (url) => {
      urls.push(url);
      const socket = new FakeWebSocket();
      sockets.push(socket);
      if (!options.neverOpen) {
        queueMicrotask(() => {
          socket.emit("open", {});
          if (options.providerCode !== undefined) {
            socket.emit("message", {
              data: JSON.stringify({
                code: options.providerCode,
                message: "UNSAFE_PROVIDER_MESSAGE",
              }),
            });
            return;
          }
          if (!options.empty) {
            socket.emit("message", { data: new Uint8Array([1, 2, 3]) });
            socket.emit("message", { data: new Uint8Array([4, 5]) });
          }
          socket.emit("message", {
            data: JSON.stringify({ code: 0, final: 1 }),
          });
        });
      }
      return socket;
    },
  };
}

async function* frames(...values: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const value of values) {
    yield value;
  }
}

async function collectAudio(
  source: AsyncIterable<Uint8Array>,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source) {
    chunks.push(chunk);
  }
  return chunks;
}

test("validates Tencent configuration without rendering credential data", () => {
  assert.deepEqual(loadTencentVoiceConfig(environment()), config());

  const unsafeValues = ["LEAK_APP", "LEAK_ID", "LEAK_KEY", "LEAK_VOICE"];
  const cases: Array<[
    Readonly<Record<string, string | undefined>>,
    TencentVoiceConfigurationError["code"],
  ]> = [
    [environment({ TENCENT_CLOUD_APP_ID: "LEAK_APP" }), "app_id_invalid"],
    [environment({ TENCENT_CLOUD_SECRET_ID: "LEAK_ID\n" }), "secret_id_invalid"],
    [environment({ TENCENT_CLOUD_SECRET_KEY: "LEAK_KEY value" }), "secret_key_invalid"],
    [environment({ TENCENT_ASR_PROFILE: "enhanced" }), "asr_profile_invalid"],
    [environment({ TENCENT_TTS_VOICE_TYPE: "LEAK_VOICE" }), "voice_type_invalid"],
    [environment({ TENCENT_VOICE_TIMEOUT_MS: "999" }), "timeout_invalid"],
  ];

  for (const [nextEnvironment, expectedCode] of cases) {
    assert.throws(
      () => loadTencentVoiceConfig(nextEnvironment),
      (error: unknown) =>
        error instanceof TencentVoiceConfigurationError &&
        error.code === expectedCode &&
        unsafeValues.every((value) => !error.message.includes(value)),
    );
  }
});

test("builds deterministic official-host ASR and TTS signatures", () => {
  const dependencies = {
    now: () => 1_700_000_000_000,
    nonce: () => 42,
    createId: () => "test-session-id",
  };
  const asr = buildAsrSignedRequest(config(), dependencies);
  const expectedAsrSignature = createHmac("sha1", "TEST_SECRET_KEY")
    .update(asr.canonicalSource, "utf8")
    .digest("base64");
  assert.equal(asr.signature, expectedAsrSignature);
  assert.match(asr.url, /^wss:\/\/asr\.cloud\.tencent\.com\/asr\/v2\/1234567890\?/);
  assert.equal(asr.url.includes("TEST_SECRET_KEY"), false);
  assert.equal(asr.canonicalSource.includes("wss://"), false);
  assert.equal(asr.canonicalSource.includes("expired=1700086400"), true);
  assert.equal(asr.canonicalSource.includes("engine_model_type=16k_zh"), true);

  const tts = buildTtsSignedRequest(config(), "固定测试", dependencies);
  const expectedTtsSignature = createHmac("sha1", "TEST_SECRET_KEY")
    .update(tts.canonicalSource, "utf8")
    .digest("base64");
  assert.equal(tts.signature, expectedTtsSignature);
  assert.match(tts.url, /^wss:\/\/tts\.cloud\.tencent\.com\/stream_ws\?/);
  assert.equal(tts.url.includes("TEST_SECRET_KEY"), false);
  assert.equal(
    tts.canonicalSource,
    "GETtts.cloud.tencent.com/stream_ws?" +
      "Action=TextToStreamAudioWS&AppId=1234567890&Codec=pcm&" +
      "EnableSubtitle=False&Expired=1700086400&ModelType=1&" +
      "SampleRate=16000&SecretId=TEST_SECRET_ID&" +
      "SessionId=test-session-id&Speed=0&Text=固定测试&" +
      "Timestamp=1700000000&VoiceType=101001&Volume=0",
  );
});

test("streams paced PCM to ASR and returns only final sentence slices", async () => {
  const mock = asrFactory({ finalText: "最终结果" });
  const delays: number[] = [];
  const partialCounts: number[] = [];
  const adapter = new TencentRealtimeAsr(config(), {
    webSocketFactory: mock.factory,
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    now: () => 1_700_000_000_000,
    nonce: () => 1,
    createId: () => "asr-session",
  });
  const result = await adapter.transcribe(frames(new Uint8Array(7_000)), {
    signal: new AbortController().signal,
    onPartialTranscript: ({ characterCount }) => partialCounts.push(characterCount),
  });

  assert.deepEqual(result, { finalTranscript: "最终结果" });
  assert.deepEqual(delays, [200, 19]);
  assert.deepEqual(
    mock.sockets[0]?.sent.filter((item) => item instanceof Uint8Array).map((item) => item.byteLength),
    [6_400, 600],
  );
  assert.equal(mock.sockets[0]?.sent.at(-1), JSON.stringify({ type: "end" }));
  assert.deepEqual(partialCounts, [2, 4]);
  assert.equal(mock.sockets[0]?.closed, true);
});

test("classifies ASR no-final and provider failures without provider text", async () => {
  const noFinal = asrFactory({ omitFinalSentence: true });
  const noFinalAdapter = new TencentRealtimeAsr(config(), {
    webSocketFactory: noFinal.factory,
    sleep: async () => undefined,
  });
  await assert.rejects(
    noFinalAdapter.transcribe(frames(new Uint8Array([1])), {
      signal: new AbortController().signal,
      onPartialTranscript: () => undefined,
    }),
    (error: unknown) =>
      error instanceof TencentVoiceProviderError && error.code === "asr_no_final",
  );

  const quota = asrFactory({ providerCode: 4004 });
  const quotaAdapter = new TencentRealtimeAsr(config(), {
    webSocketFactory: quota.factory,
    sleep: async () => undefined,
  });
  await assert.rejects(
    quotaAdapter.transcribe(frames(new Uint8Array([1])), {
      signal: new AbortController().signal,
      onPartialTranscript: () => undefined,
    }),
    (error: unknown) =>
      error instanceof TencentVoiceProviderError &&
      error.code === "quota_or_billing" &&
      error.providerCode === 4004 &&
      !error.message.includes("UNSAFE_PROVIDER_MESSAGE"),
  );
});

test("cancels and times out ASR without retrying", async () => {
  const cancelMock = asrFactory();
  const controller = new AbortController();
  const cancelAdapter = new TencentRealtimeAsr(config(), {
    webSocketFactory: cancelMock.factory,
    sleep: async (_milliseconds, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new TencentVoiceProviderError("cancelled")),
          { once: true },
        );
      }),
  });
  const cancelled = cancelAdapter.transcribe(frames(new Uint8Array([1])), {
    signal: controller.signal,
    onPartialTranscript: () => undefined,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) =>
      error instanceof TencentVoiceProviderError && error.code === "cancelled",
  );
  assert.equal(cancelMock.sockets.length, 1);
  assert.equal(cancelMock.sockets[0]?.closed, true);

  const timeoutMock = asrFactory({ neverOpen: true });
  const timeoutAdapter = new TencentRealtimeAsr(config({ timeoutMs: 10 }), {
    webSocketFactory: timeoutMock.factory,
  });
  await assert.rejects(
    timeoutAdapter.transcribe(frames(new Uint8Array([1])), {
      signal: new AbortController().signal,
      onPartialTranscript: () => undefined,
    }),
    (error: unknown) =>
      error instanceof TencentVoiceProviderError && error.code === "timed_out",
  );
  assert.equal(timeoutMock.sockets.length, 1);
});

test("streams TTS PCM until final=1 and closes the socket", async () => {
  const mock = ttsFactory();
  const adapter = new TencentRealtimeTts(config(), {
    webSocketFactory: mock.factory,
    now: () => 1_700_000_000_000,
    createId: () => "tts-session",
  });
  const chunks = await collectAudio(
    adapter.synthesize("固定测试", { signal: new AbortController().signal }),
  );
  assert.deepEqual(chunks.map((chunk) => [...chunk]), [[1, 2, 3], [4, 5]]);
  assert.equal(mock.sockets[0]?.binaryType, "arraybuffer");
  assert.equal(mock.sockets[0]?.closed, true);
  assert.equal(mock.urls[0]?.includes(encodeURIComponent("固定测试")), true);
});

test("classifies empty, authentication, cancellation, and timeout TTS paths", async () => {
  const emptyMock = ttsFactory({ empty: true });
  await assert.rejects(
    collectAudio(
      new TencentRealtimeTts(config(), {
        webSocketFactory: emptyMock.factory,
      }).synthesize("固定测试", { signal: new AbortController().signal }),
    ),
    (error: unknown) =>
      error instanceof TencentVoiceProviderError && error.code === "tts_no_audio",
  );

  const authMock = ttsFactory({ providerCode: 10003 });
  await assert.rejects(
    collectAudio(
      new TencentRealtimeTts(config(), {
        webSocketFactory: authMock.factory,
      }).synthesize("固定测试", { signal: new AbortController().signal }),
    ),
    (error: unknown) =>
      error instanceof TencentVoiceProviderError &&
      error.code === "auth" &&
      !error.message.includes("UNSAFE_PROVIDER_MESSAGE"),
  );

  const controller = new AbortController();
  const cancelMock = ttsFactory({ neverOpen: true });
  const cancelled = collectAudio(
    new TencentRealtimeTts(config(), {
      webSocketFactory: cancelMock.factory,
    }).synthesize("固定测试", { signal: controller.signal }),
  );
  controller.abort();
  await assert.rejects(
    cancelled,
    (error: unknown) =>
      error instanceof TencentVoiceProviderError && error.code === "cancelled",
  );

  const timeoutMock = ttsFactory({ neverOpen: true });
  await assert.rejects(
    collectAudio(
      new TencentRealtimeTts(config({ timeoutMs: 10 }), {
        webSocketFactory: timeoutMock.factory,
      }).synthesize("固定测试", { signal: new AbortController().signal }),
    ),
    (error: unknown) =>
      error instanceof TencentVoiceProviderError && error.code === "timed_out",
  );
});

test("injects Tencent adapters into VOICE-001 and completes an offline turn", async () => {
  const asrMock = asrFactory({ finalText: "测试问题" });
  const ttsMock = ttsFactory();
  const adapters = createTencentVoiceGatewayAdapters(environment(), {
    asr: {
      webSocketFactory: asrMock.factory,
      sleep: async () => undefined,
    },
    tts: { webSocketFactory: ttsMock.factory },
  });
  const playback = new RecordingPlayback();
  const gateway = new VoiceGateway({
    asr: adapters.asr,
    router: new StaticRouter({ kind: "direct", text: "测试回答" }),
    reasoner: new StaticReasoner([]),
    tts: adapters.tts,
    playback,
    createSessionId: () => "integration-session",
  });
  const session = gateway.createSession();
  const completion = session.begin();
  session.pushAudio(new Uint8Array([1, 2]));
  session.endAudio();
  assert.deepEqual(await completion, { kind: "completed" });
  assert.equal(playback.playedChunkCount, 2);
  assert.equal(session.state, "IDLE");
});

test("keeps a Tencent provider failure inside the VOICE-001 ASR boundary", async () => {
  const asrMock = asrFactory({ providerCode: 4004 });
  let ttsConnections = 0;
  const router = new StaticRouter({ kind: "direct", text: "不得到达" });
  const adapters = createTencentVoiceGatewayAdapters(environment(), {
    asr: {
      webSocketFactory: asrMock.factory,
      sleep: async () => undefined,
    },
    tts: {
      webSocketFactory: () => {
        ttsConnections += 1;
        return new FakeWebSocket();
      },
    },
  });
  const gateway = new VoiceGateway({
    asr: adapters.asr,
    router,
    reasoner: new StaticReasoner([]),
    tts: adapters.tts,
    playback: new RecordingPlayback(),
    createSessionId: () => "failure-session",
  });
  const session = gateway.createSession();
  assert.deepEqual(await session.begin(), {
    kind: "failed",
    stage: "asr",
    code: "asr_error",
  });
  assert.equal(router.requests.length, 0);
  assert.equal(ttsConnections, 0);
  assert.equal(asrMock.sockets.length, 1);
  assert.equal(session.state, "IDLE");
});

test("offline Probe validates signing without creating a WebSocket or leaking data", async () => {
  let networkAttempts = 0;
  const forbiddenFactory = () => {
    networkAttempts += 1;
    throw new Error("NETWORK_MUST_NOT_RUN");
  };
  const report = await runTencentVoiceProbe({
    environment: environment(),
    asrDependencies: {
      webSocketFactory: forbiddenFactory,
      now: () => 1_700_000_000_000,
      nonce: () => 7,
      createId: () => "asr-probe",
    },
    ttsDependencies: {
      webSocketFactory: forbiddenFactory,
      now: () => 1_700_000_000_000,
      createId: () => "tts-probe",
    },
  });
  assert.deepEqual(report, {
    mode: "offline",
    configValid: true,
    signingSelfCheck: true,
    networkAttempted: false,
  });
  assert.equal(networkAttempts, 0);
  const serialized = JSON.stringify(report);
  for (const unsafe of [
    "TEST_SECRET_ID",
    "TEST_SECRET_KEY",
    "Signature",
    "asr.cloud.tencent.com",
    "tts.cloud.tencent.com",
    "你好，这是语音测试。",
  ]) {
    assert.equal(serialized.includes(unsafe), false);
  }
});

test("controlled Probe path is bounded and report-only under mocked providers", async () => {
  const asrMock = asrFactory({ finalText: "固定结果" });
  const ttsMock = ttsFactory();
  const report = await runTencentVoiceProbe({
    environment: environment(),
    confirmBillable: true,
    asrDependencies: {
      webSocketFactory: asrMock.factory,
      sleep: async () => undefined,
      now: () => 1_700_000_000_000,
      nonce: () => 9,
      createId: () => "asr-live-mock",
    },
    ttsDependencies: {
      webSocketFactory: ttsMock.factory,
      now: () => 1_700_000_000_000,
      createId: () => "tts-live-mock",
    },
  });
  assert.equal(report.mode, "controlled-live");
  assert.equal(report.networkAttempted, true);
  assert.equal(report.ttsAudioChunkCount, 2);
  assert.equal(report.ttsAudioByteCount, 5);
  assert.equal(report.asrFinalPresent, true);
  assert.equal(asrMock.sockets.length, 1);
  assert.equal(ttsMock.sockets.length, 1);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes("固定结果"), false);
  assert.equal(serialized.includes("TEST_SECRET"), false);
});
