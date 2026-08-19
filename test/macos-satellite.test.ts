import assert from "node:assert/strict";
import test from "node:test";

import {
  StaticReasoner,
  StaticRouter,
  StaticTts,
  type AsrAdapter,
  type AsrFinalResult,
} from "../packages/voice-session/src/index.js";
import { VoiceGateway } from "../apps/voice-gateway/src/development-gateway.js";
import { VoiceLoopCommandScheduler } from "../apps/voice-gateway/src/voice-loop-command-scheduler.js";
import {
  formatVoiceCaptureSummary,
  formatVoiceTurnOutcome,
} from "../apps/voice-gateway/src/voice-loop-safe-output.js";
import {
  MacosSatelliteClient,
  MacosSatelliteClientError,
  type MacosSatelliteMetric,
} from "../apps/voice-gateway/src/satellite/macos-satellite-client.js";
import { MacosSatelliteRuntime } from "../apps/voice-gateway/src/satellite/macos-satellite-runtime.js";
import {
  encodeSatelliteFrame,
  SatelliteFrameDecoder,
  SatelliteMessageKind,
  type SatelliteFrame,
} from "../apps/voice-gateway/src/satellite/protocol.js";
import type {
  SatelliteProcessExit,
  SatelliteTransport,
} from "../apps/voice-gateway/src/satellite/process-transport.js";
import { sanitizeSatelliteEnvironment } from "../apps/voice-gateway/src/satellite/process-transport.js";

test("child process environment excludes Gateway and cloud credentials", () => {
  assert.deepEqual(
    sanitizeSatelliteEnvironment({
      PATH: "/safe/bin",
      LANG: "en_US.UTF-8",
      HOME: "/private/home",
      TENCENT_CLOUD_SECRET_KEY: "SECRET_TENCENT",
      IVAN_ONLINE_API_KEY: "SECRET_REASONER",
      SOL_UNRELATED_SECRET: "SECRET_OTHER",
    }),
    { PATH: "/safe/bin", LANG: "en_US.UTF-8" },
  );
});

test("interrupt bypasses a stop command waiting for playback", async () => {
  const events: string[] = [];
  let releaseStop: (() => void) | undefined;
  const stopPending = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const scheduler = new VoiceLoopCommandScheduler(
    async (command) => {
      events.push(`${command}:started`);
      if (command === "stop") {
        await stopPending;
      }
      events.push(`${command}:finished`);
    },
    (command) => events.push(`${command}:failed`),
  );

  scheduler.dispatch("stop");
  await waitFor(() => events.includes("stop:started"));
  scheduler.dispatch("interrupt");
  await waitFor(() => events.includes("interrupt:finished"));

  assert.deepEqual(events, [
    "stop:started",
    "interrupt:started",
    "interrupt:finished",
  ]);
  releaseStop?.();
  await scheduler.drain();
  assert.equal(events.at(-1), "stop:finished");
});

test("safe turn output includes failure and interruption diagnostics", () => {
  assert.equal(formatVoiceTurnOutcome(undefined), "idle");
  assert.equal(formatVoiceTurnOutcome({ kind: "completed" }), "completed");
  assert.equal(
    formatVoiceTurnOutcome({
      kind: "failed",
      stage: "asr",
      code: "asr_error",
    }),
    "failed stage=asr code=asr_error",
  );
  assert.equal(
    formatVoiceTurnOutcome({ kind: "interrupted", stage: "playback" }),
    "interrupted stage=playback",
  );
  assert.equal(
    formatVoiceCaptureSummary({
      frameCount: 12,
      byteCount: 6_400,
      durationMs: 200,
      reason: 0,
    }),
    "frames=12 bytes=6400 duration_ms=200 reason=0",
  );
});

test("permission denial stays offline and blocks capture", async () => {
  const transport = new FakeSatelliteTransport((frame, fake) => {
    if (frame.kind === SatelliteMessageKind.requestPermission) {
      fake.emit({
        kind: SatelliteMessageKind.permissionState,
        payload: Uint8Array.of(2),
      });
    } else if (frame.kind === SatelliteMessageKind.shutdown) {
      fake.emit({
        kind: SatelliteMessageKind.shutdownComplete,
        payload: new Uint8Array(),
      });
    }
  });
  transport.emit({ kind: SatelliteMessageKind.hello, payload: new Uint8Array() });
  const client = new MacosSatelliteClient({ transport });

  assert.equal(await client.initialize(), "denied");
  assert.equal(client.state, "permission_blocked");
  await assert.rejects(
    client.startCapture(),
    (error: unknown) => error instanceof MacosSatelliteClientError,
  );
  assert.equal(
    transport.writes.some(
      (frame) => frame.kind === SatelliteMessageKind.startCapture,
    ),
    false,
  );

  await client.shutdown();
});

test("unexpected child-process exit fails a pending operation safely", async () => {
  const transport = new FakeSatelliteTransport((frame, fake) => {
    if (frame.kind === SatelliteMessageKind.requestPermission) {
      fake.closeInput();
    }
  });
  transport.emit({ kind: SatelliteMessageKind.hello, payload: new Uint8Array() });
  const client = new MacosSatelliteClient({ transport, operationTimeoutMs: 100 });

  await assert.rejects(
    client.initialize(),
    (error: unknown) =>
      error instanceof MacosSatelliteClientError &&
      error.code === "transport_closed",
  );
  assert.equal(client.state, "failed");
});

test("manual capture completes one Gateway turn without retaining content", async () => {
  const metrics: MacosSatelliteMetric[] = [];
  const transport = authorizedTransport({ finishPlayback: true });
  const client = new MacosSatelliteClient({
    transport,
    recordMetric: (metric) => metrics.push(metric),
  });
  const asr = new CountingAsr("PRIVATE_TRANSCRIPT");
  const gateway = new VoiceGateway({
    asr,
    router: new StaticRouter({ kind: "direct", text: "PRIVATE_ANSWER" }),
    reasoner: new StaticReasoner([]),
    tts: new StaticTts([Uint8Array.of(1, 2)]),
    playback: client,
    createSessionId: () => "safe-session-id",
  });
  const runtime = new MacosSatelliteRuntime({ client, gateway });

  assert.equal(await runtime.initialize(), "ready");
  assert.equal(asr.calls, 0);
  await runtime.beginCapture();
  transport.emit({
    kind: SatelliteMessageKind.audioInput,
    payload: Uint8Array.of(1, 2, 3, 4),
  });
  const outcome = await runtime.endCapture();

  assert.deepEqual(outcome, { kind: "completed" });
  assert.equal(asr.calls, 1);
  assert.equal(asr.byteCount, 4);
  assert.equal(runtime.state, "ready");
  const serializedMetrics = JSON.stringify(metrics);
  assert.equal(serializedMetrics.includes("PRIVATE_TRANSCRIPT"), false);
  assert.equal(serializedMetrics.includes("PRIVATE_ANSWER"), false);
  assert.equal(serializedMetrics.includes("1,2,3,4"), false);
  await runtime.shutdown();
});

test("stop remains valid after the Satellite reaches its capture limit", async () => {
  const transport = authorizedTransport({ finishPlayback: false });
  const client = new MacosSatelliteClient({ transport });
  const gateway = new VoiceGateway({
    asr: new CountingAsr("transcript"),
    router: new StaticRouter({ kind: "direct", text: "answer" }),
    reasoner: new StaticReasoner([]),
    tts: new StaticTts([Uint8Array.of(1, 2)]),
    playback: client,
  });
  const runtime = new MacosSatelliteRuntime({ client, gateway });
  await runtime.initialize();
  await runtime.beginCapture();
  transport.emit({
    kind: SatelliteMessageKind.audioInput,
    payload: Uint8Array.of(1, 2),
  });
  transport.emit({
    kind: SatelliteMessageKind.captureStopped,
    payload: Uint8Array.of(1),
  });
  await waitFor(() => runtime.state !== "capturing");

  const completion = runtime.endCapture();
  void completion.catch(() => undefined);
  await waitFor(() =>
    transport.writes.some(
      (frame) => frame.kind === SatelliteMessageKind.playAudio,
    ),
  );
  const interrupted = await runtime.interrupt();

  assert.deepEqual(interrupted, { kind: "interrupted", stage: "playback" });
  assert.deepEqual(await completion, {
    kind: "interrupted",
    stage: "playback",
  });
  await waitFor(() => runtime.state === "ready");
  await runtime.shutdown();
});

test("manual playback interruption cancels the provider and returns ready", async () => {
  const transport = authorizedTransport({ finishPlayback: false });
  const client = new MacosSatelliteClient({ transport });
  const gateway = new VoiceGateway({
    asr: new CountingAsr("transcript"),
    router: new StaticRouter({ kind: "direct", text: "answer" }),
    reasoner: new StaticReasoner([]),
    tts: new StaticTts([Uint8Array.of(1, 2)]),
    playback: client,
  });
  const runtime = new MacosSatelliteRuntime({ client, gateway });
  await runtime.initialize();
  await runtime.beginCapture();
  transport.emit({
    kind: SatelliteMessageKind.audioInput,
    payload: Uint8Array.of(1, 2),
  });
  const completion = runtime.endCapture();
  await waitFor(() =>
    transport.writes.some(
      (frame) => frame.kind === SatelliteMessageKind.playAudio,
    ),
  );

  const interrupted = await runtime.interrupt();
  assert.deepEqual(interrupted, { kind: "interrupted", stage: "playback" });
  assert.deepEqual(await completion, {
    kind: "interrupted",
    stage: "playback",
  });
  await waitFor(() => runtime.state === "ready");
  assert.equal(
    transport.writes.some((frame) => frame.kind === SatelliteMessageKind.cancel),
    true,
  );
  await runtime.shutdown();
});

interface AuthorizedTransportOptions {
  readonly finishPlayback: boolean;
}

function authorizedTransport(
  options: AuthorizedTransportOptions,
): FakeSatelliteTransport {
  let capturing = false;
  let playing = false;
  const transport = new FakeSatelliteTransport((frame, fake) => {
    switch (frame.kind) {
      case SatelliteMessageKind.requestPermission:
        fake.emit({
          kind: SatelliteMessageKind.permissionState,
          payload: Uint8Array.of(1),
        });
        return;
      case SatelliteMessageKind.startCapture:
        capturing = true;
        fake.emit({
          kind: SatelliteMessageKind.captureStarted,
          payload: new Uint8Array(),
        });
        return;
      case SatelliteMessageKind.stopCapture:
        capturing = false;
        fake.emit({
          kind: SatelliteMessageKind.captureStopped,
          payload: Uint8Array.of(0),
        });
        return;
      case SatelliteMessageKind.playAudio:
        playing = true;
        fake.emit({
          kind: SatelliteMessageKind.playbackStarted,
          payload: new Uint8Array(),
        });
        if (options.finishPlayback) {
          playing = false;
          fake.emit({
            kind: SatelliteMessageKind.playbackFinished,
            payload: Uint8Array.of(0),
          });
        }
        return;
      case SatelliteMessageKind.cancel:
        if (capturing) {
          capturing = false;
          fake.emit({
            kind: SatelliteMessageKind.captureStopped,
            payload: Uint8Array.of(4),
          });
        }
        if (playing) {
          playing = false;
          fake.emit({
            kind: SatelliteMessageKind.playbackFinished,
            payload: Uint8Array.of(3),
          });
        }
        fake.emit({
          kind: SatelliteMessageKind.cancelled,
          payload: new Uint8Array(),
        });
        return;
      case SatelliteMessageKind.shutdown:
        fake.emit({
          kind: SatelliteMessageKind.shutdownComplete,
          payload: new Uint8Array(),
        });
        return;
    }
  });
  transport.emit({ kind: SatelliteMessageKind.hello, payload: new Uint8Array() });
  return transport;
}

class CountingAsr implements AsrAdapter {
  public calls = 0;
  public byteCount = 0;

  public constructor(private readonly transcript: string) {}

  public async transcribe(
    audio: AsyncIterable<Uint8Array>,
    options: {
      readonly signal: AbortSignal;
      readonly onPartialTranscript: (event: {
        readonly characterCount: number;
      }) => void;
    },
  ): Promise<AsrFinalResult> {
    this.calls += 1;
    for await (const frame of audio) {
      if (options.signal.aborted) {
        throw new Error("cancelled");
      }
      this.byteCount += frame.byteLength;
    }
    return { finalTranscript: this.transcript };
  }
}

class FakeSatelliteTransport implements SatelliteTransport {
  readonly #decoder = new SatelliteFrameDecoder();
  readonly #queue = new AsyncChunkQueue();
  readonly #onWrite: (
    frame: SatelliteFrame,
    transport: FakeSatelliteTransport,
  ) => void;

  public readonly writes: SatelliteFrame[] = [];
  public readonly output: AsyncIterable<Uint8Array> = this.#queue;
  public readonly exit: Promise<SatelliteProcessExit> = new Promise(() =>
    undefined,
  );

  public constructor(
    onWrite: (
      frame: SatelliteFrame,
      transport: FakeSatelliteTransport,
    ) => void,
  ) {
    this.#onWrite = onWrite;
  }

  public async write(encoded: Uint8Array): Promise<void> {
    const frames = this.#decoder.push(encoded);
    assert.equal(frames.length, 1);
    const frame = frames[0];
    assert.ok(frame);
    this.writes.push(frame);
    this.#onWrite(frame, this);
  }

  public emit(frame: SatelliteFrame): void {
    const encoded = encodeSatelliteFrame(frame);
    const split = Math.min(5, encoded.byteLength);
    this.#queue.push(encoded.subarray(0, split));
    this.#queue.push(encoded.subarray(split));
  }

  public closeInput(): void {
    this.#queue.close();
  }

  public terminate(): void {
    this.#queue.close();
  }
}

class AsyncChunkQueue implements AsyncIterable<Uint8Array> {
  readonly #chunks: Uint8Array[] = [];
  readonly #waiters: Array<(chunk: Uint8Array | undefined) => void> = [];
  #closed = false;

  public push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0 || this.#closed) {
      return;
    }
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter(chunk);
    } else {
      this.#chunks.push(chunk);
    }
  }

  public close(): void {
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter(undefined);
    }
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    while (true) {
      const chunk = this.#chunks.shift();
      if (chunk !== undefined) {
        yield chunk;
        continue;
      }
      if (this.#closed) {
        return;
      }
      const next = await new Promise<Uint8Array | undefined>((resolve) => {
        this.#waiters.push(resolve);
      });
      if (next === undefined) {
        return;
      }
      yield next;
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for condition");
}
