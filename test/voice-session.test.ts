import assert from "node:assert/strict";
import test from "node:test";

import {
  InMemoryMetrics,
  RecordingPlayback,
  ScriptedAsr,
  StaticReasoner,
  StaticRouter,
  StaticTts,
  VoiceSession,
  VoiceSessionError,
  type AsrAdapter,
  type AsrFinalResult,
  type PlaybackAdapter,
  type ReasonerAdapter,
  type ReasonerRequest,
  type ResponseRouter,
  type RouteRequest,
  type TtsAdapter,
  type VoiceSessionDependencies,
} from "../packages/voice-session/src/index.js";

test("runs the deterministic ASR → reasoner → TTS path and returns to IDLE", async () => {
  const metrics = new InMemoryMetrics();
  const asr = new ScriptedAsr("test transcript");
  const router = new StaticRouter({ kind: "reason", sessionSummary: "brief" });
  const reasoner = new StaticReasoner(["first", "second"]);
  const tts = new StaticTts();
  const playback = new RecordingPlayback();
  const session = new VoiceSession({
    sessionId: "normal-session",
    asr,
    router,
    reasoner,
    tts,
    playback,
    metrics,
  });

  const completion = session.begin();
  assert.equal(session.state, "ASR_STREAMING");
  session.pushAudio(new Uint8Array([1, 2, 3]));
  session.endAudio();

  assert.deepEqual(await completion, { kind: "completed" });
  assert.equal(session.state, "IDLE");
  assert.equal(asr.calls, 1);
  assert.equal(playback.playedChunkCount, 2);
  assert.equal(tts.calls, 2);
  assert.deepEqual(Object.keys(reasoner.requests[0] ?? {}).sort(), [
    "finalTranscript",
    "sessionSummary",
  ]);
  assert.equal("audio" in (reasoner.requests[0] ?? {}), false);
  assert.ok(metrics.events.some((event) => event.type === "state_changed"));
});

test("rejects audio before explicit local activation", () => {
  const asr = new ScriptedAsr("should not be called");
  const session = new VoiceSession(defaultDependencies({ asr }));

  assert.throws(
    () => session.pushAudio(new Uint8Array([1])),
    (error: unknown) =>
      error instanceof VoiceSessionError &&
      error.code === "audio_before_activation",
  );
  assert.equal(asr.calls, 0);
});

test("interrupting ASR aborts a provider that ignores cancellation", async () => {
  const asr = new BlockingAsr();
  const session = new VoiceSession(defaultDependencies({ asr }));

  const completion = session.begin();
  await waitFor(() => asr.started);

  assert.deepEqual(await session.interrupt(), {
    kind: "interrupted",
    stage: "asr",
  });
  assert.deepEqual(await completion, { kind: "interrupted", stage: "asr" });
  assert.equal(asr.signal?.aborted, true);
  assert.equal(session.state, "IDLE");
});

test("interrupting deep reasoning prevents TTS from starting", async () => {
  const reasoner = new BlockingReasoner();
  const tts = new StaticTts();
  const session = new VoiceSession(
    defaultDependencies({
      asr: new ScriptedAsr("needs reasoning"),
      router: new StaticRouter({ kind: "reason" }),
      reasoner,
      tts,
    }),
  );

  const completion = session.begin();
  session.pushAudio(new Uint8Array([1]));
  session.endAudio();
  await waitFor(() => reasoner.started);

  assert.deepEqual(await session.interrupt(), {
    kind: "interrupted",
    stage: "reasoner",
  });
  assert.deepEqual(await completion, {
    kind: "interrupted",
    stage: "reasoner",
  });
  assert.equal(reasoner.signal?.aborted, true);
  assert.equal(tts.calls, 0);
});

test("interrupting TTS stops a stream that does not cooperate", async () => {
  const tts = new BlockingTts();
  const session = new VoiceSession(
    defaultDependencies({
      asr: new ScriptedAsr("direct answer"),
      router: new StaticRouter({ kind: "direct", text: "response" }),
      tts,
    }),
  );

  const completion = session.begin();
  session.pushAudio(new Uint8Array([1]));
  session.endAudio();
  await waitFor(() => tts.started);

  assert.deepEqual(await session.interrupt(), {
    kind: "interrupted",
    stage: "tts",
  });
  assert.deepEqual(await completion, { kind: "interrupted", stage: "tts" });
  assert.equal(tts.signal?.aborted, true);
});

test("interrupting playback stops the current audio operation", async () => {
  const playback = new BlockingPlayback();
  const session = new VoiceSession(
    defaultDependencies({
      asr: new ScriptedAsr("direct answer"),
      router: new StaticRouter({ kind: "direct", text: "response" }),
      playback,
    }),
  );

  const completion = session.begin();
  session.pushAudio(new Uint8Array([1]));
  session.endAudio();
  await waitFor(() => playback.started);

  assert.deepEqual(await session.interrupt(), {
    kind: "interrupted",
    stage: "playback",
  });
  assert.deepEqual(await completion, {
    kind: "interrupted",
    stage: "playback",
  });
  assert.equal(playback.signal?.aborted, true);
});

test("provider failure closes the session without invoking later stages or retrying", async () => {
  const asr = new ThrowingAsr();
  const router = new CountingRouter();
  const tts = new StaticTts();
  const session = new VoiceSession(defaultDependencies({ asr, router, tts }));

  assert.deepEqual(await session.begin(), {
    kind: "failed",
    stage: "asr",
    code: "asr_error",
  });
  assert.equal(asr.calls, 1);
  assert.equal(router.calls, 0);
  assert.equal(tts.calls, 0);
  assert.equal(session.state, "IDLE");
});

test("adapter timeout aborts the active operation and closes the session", async () => {
  const asr = new BlockingAsr();
  const router = new CountingRouter();
  const session = new VoiceSession(
    defaultDependencies({
      asr,
      router,
      timeouts: { asrMs: 5 },
    }),
  );

  assert.deepEqual(await session.begin(), {
    kind: "failed",
    stage: "asr",
    code: "asr_timeout",
  });
  assert.equal(asr.signal?.aborted, true);
  assert.equal(router.calls, 0);
  assert.equal(session.state, "IDLE");
});

test("metrics do not serialize transcript, response text, or audio bytes", async () => {
  const transcript = "TRANSCRIPT_MUST_NOT_APPEAR";
  const response = "RESPONSE_MUST_NOT_APPEAR";
  const metrics = new InMemoryMetrics();
  const session = new VoiceSession(
    defaultDependencies({
      asr: new ScriptedAsr(transcript),
      router: new StaticRouter({ kind: "direct", text: response }),
      metrics,
    }),
  );

  const completion = session.begin();
  session.pushAudio(new Uint8Array([7, 8, 9]));
  session.endAudio();
  await completion;

  const serializedMetrics = JSON.stringify(metrics.events);
  assert.equal(serializedMetrics.includes(transcript), false);
  assert.equal(serializedMetrics.includes(response), false);
  assert.equal(serializedMetrics.includes("7,8,9"), false);
});

function defaultDependencies(
  overrides: Partial<VoiceSessionDependencies> = {},
): VoiceSessionDependencies {
  return {
    sessionId: "test-session",
    asr: new ScriptedAsr("test transcript"),
    router: new StaticRouter({ kind: "direct", text: "response" }),
    reasoner: new StaticReasoner(["response"]),
    tts: new StaticTts(),
    playback: new RecordingPlayback(),
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) {
      return;
    }

    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  assert.fail("Timed out waiting for the adapter to start");
}

class BlockingAsr implements AsrAdapter {
  public started = false;
  public signal: AbortSignal | undefined;

  public async transcribe(
    _audio: AsyncIterable<Uint8Array>,
    options: {
      readonly signal: AbortSignal;
      readonly onPartialTranscript: (event: {
        readonly characterCount: number;
      }) => void;
    },
  ): Promise<AsrFinalResult> {
    this.started = true;
    this.signal = options.signal;
    return new Promise<AsrFinalResult>(() => undefined);
  }
}

class BlockingReasoner implements ReasonerAdapter {
  public started = false;
  public signal: AbortSignal | undefined;

  public async *stream(
    _request: ReasonerRequest,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<string> {
    this.started = true;
    this.signal = options.signal;
    await new Promise<void>(() => undefined);
    yield "unreachable";
  }
}

class BlockingTts implements TtsAdapter {
  public started = false;
  public signal: AbortSignal | undefined;

  public async *synthesize(
    _text: string,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<Uint8Array> {
    this.started = true;
    this.signal = options.signal;
    await new Promise<void>(() => undefined);
    yield new Uint8Array([1]);
  }
}

class BlockingPlayback implements PlaybackAdapter {
  public started = false;
  public signal: AbortSignal | undefined;

  public async play(
    _audio: Uint8Array,
    options: { readonly signal: AbortSignal },
  ): Promise<void> {
    this.started = true;
    this.signal = options.signal;
    return new Promise<void>(() => undefined);
  }
}

class ThrowingAsr implements AsrAdapter {
  public calls = 0;

  public async transcribe(
    _audio: AsyncIterable<Uint8Array>,
    _options: {
      readonly signal: AbortSignal;
      readonly onPartialTranscript: (event: {
        readonly characterCount: number;
      }) => void;
    },
  ): Promise<AsrFinalResult> {
    this.calls += 1;
    throw new Error("provider unavailable");
  }
}

class CountingRouter implements ResponseRouter {
  public calls = 0;

  public async route(
    _request: RouteRequest,
    _options: { readonly signal: AbortSignal },
  ): Promise<{ readonly kind: "direct"; readonly text: string }> {
    this.calls += 1;
    return { kind: "direct", text: "unreachable" };
  }
}
