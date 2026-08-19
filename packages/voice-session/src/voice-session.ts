import { SessionAudioInput } from "./audio-input.js";
import { BoundedAsyncQueue } from "./bounded-async-queue.js";
import type {
  FailureCode,
  MetricsSink,
  ReasonerRequest,
  SafeMetricEvent,
  SessionOutcome,
  SessionStage,
  SessionState,
  SessionTimeouts,
  VoiceSessionDependencies,
} from "./contracts.js";
import {
  assertNotAborted,
  failureCodeFor,
  raceWithAbortAndTimeout,
  SessionInterruptedError,
  SessionTimeoutError,
  VoiceSessionError,
} from "./errors.js";
import { NoopMetrics } from "./metrics.js";

const defaultTimeouts: SessionTimeouts = {
  asrMs: 30_000,
  routerMs: 10_000,
  reasonerMs: 30_000,
  ttsMs: 15_000,
  playbackMs: 15_000,
};
const maximumPlaybackBatchBytes = 64 * 1_024;

const allowedTransitions: Readonly<Record<SessionState, readonly SessionState[]>> = {
  IDLE: ["AWAKE"],
  AWAKE: ["ASR_STREAMING", "CLOSING"],
  ASR_STREAMING: ["ROUTING", "CLOSING"],
  ROUTING: ["DEEP_REASONING", "TTS_STREAMING", "CLOSING"],
  DEEP_REASONING: ["TTS_STREAMING", "FALLBACK", "CLOSING"],
  TTS_STREAMING: ["SPEAKING", "DEEP_REASONING", "CLOSING"],
  SPEAKING: ["TTS_STREAMING", "CLOSING"],
  FALLBACK: ["CLOSING"],
  CLOSING: ["IDLE"],
};

/**
 * Owns one short-lived voice turn. The class intentionally does not know about
 * audio devices, cloud credentials, persistent memory, or logging transports.
 */
export class VoiceSession {
  readonly #metrics: MetricsSink;
  readonly #now: () => number;
  readonly #timeouts: SessionTimeouts;

  #state: SessionState = "IDLE";
  #stage: SessionStage = "session";
  #input: SessionAudioInput | undefined;
  #controller: AbortController | undefined;
  #completion: Promise<SessionOutcome> | undefined;

  public constructor(private readonly dependencies: VoiceSessionDependencies) {
    this.#metrics = dependencies.metrics ?? new NoopMetrics();
    this.#now = dependencies.now ?? Date.now;
    this.#timeouts = resolveTimeouts(dependencies.timeouts);
  }

  public get state(): SessionState {
    return this.#state;
  }

  /**
   * Explicit local activation is the diagnostic replacement for a future local
   * wake-word event. No audio is accepted before this method succeeds.
   */
  public begin(): Promise<SessionOutcome> {
    if (this.#state !== "IDLE") {
      throw new VoiceSessionError(
        "invalid_transition",
        "A voice session is already active",
      );
    }

    const input = new SessionAudioInput();
    const controller = new AbortController();
    this.#input = input;
    this.#controller = controller;

    this.#transition("AWAKE");
    this.#transition("ASR_STREAMING");
    const completion = this.#run(input, controller.signal);
    this.#completion = completion;
    return completion;
  }

  /**
   * Accepts one frame only while the explicit session is actively streaming to
   * ASR. The method never exposes frames to routing or reasoning adapters.
   */
  public pushAudio(frame: Uint8Array): void {
    if (this.#state !== "ASR_STREAMING" || this.#input === undefined) {
      throw new VoiceSessionError(
        "audio_before_activation",
        "Audio is only accepted after local activation and before ASR completes",
      );
    }

    this.#input.push(frame);
  }

  public endAudio(): void {
    if (this.#state !== "ASR_STREAMING" || this.#input === undefined) {
      throw new VoiceSessionError(
        "invalid_transition",
        "Audio input is not currently streaming",
      );
    }

    this.#input.close();
  }

  /**
   * Cancels every active adapter through one signal and returns after the core
   * reaches IDLE. Adapters that ignore AbortSignal cannot emit further output
   * into this session because all awaited work is raced against the signal.
   */
  public async interrupt(): Promise<SessionOutcome | undefined> {
    const completion = this.#completion;
    if (completion === undefined || this.#state === "IDLE") {
      return undefined;
    }

    this.#controller?.abort();
    this.#input?.close();
    return completion;
  }

  async #run(
    input: SessionAudioInput,
    signal: AbortSignal,
  ): Promise<SessionOutcome> {
    try {
      this.#stage = "asr";
      this.#recordAdapter("adapter_started", "asr");
      const asrResult = await this.#awaitStage(
        this.dependencies.asr.transcribe(input, {
          signal,
          onPartialTranscript: ({ characterCount }) => {
            this.#metrics.record({
              type: "partial_transcript",
              sessionId: this.dependencies.sessionId,
              characterCount,
              atMs: this.#now(),
            });
          },
        }),
        this.#timeouts.asrMs,
        signal,
      );
      assertNotAborted(signal);
      this.#recordAdapter("adapter_completed", "asr");

      this.#transition("ROUTING");
      this.#stage = "router";
      this.#recordAdapter("adapter_started", "router");
      const responsePlan = await this.#awaitStage(
        this.dependencies.router.route(
          { finalTranscript: asrResult.finalTranscript },
          { signal },
        ),
        this.#timeouts.routerMs,
        signal,
      );
      assertNotAborted(signal);
      this.#recordAdapter("adapter_completed", "router");

      if (responsePlan.kind === "direct") {
        await this.#speak(responsePlan.text, signal);
      } else {
        await this.#reason(
          this.#reasonerRequest(
            asrResult.finalTranscript,
            responsePlan.sessionSummary,
          ),
          signal,
        );
      }

      return { kind: "completed" };
    } catch (error: unknown) {
      if (error instanceof SessionTimeoutError) {
        const code = failureCodeFor(this.#stage, error);
        this.#metrics.record({
          type: "failed",
          sessionId: this.dependencies.sessionId,
          stage: this.#stage,
          code,
          atMs: this.#now(),
        });
        return { kind: "failed", stage: this.#stage, code };
      }

      if (signal.aborted || error instanceof SessionInterruptedError) {
        this.#metrics.record({
          type: "interrupted",
          sessionId: this.dependencies.sessionId,
          stage: this.#stage,
          atMs: this.#now(),
        });
        return { kind: "interrupted", stage: this.#stage };
      }

      const code = failureCodeFor(this.#stage, error);
      this.#metrics.record({
        type: "failed",
        sessionId: this.dependencies.sessionId,
        stage: this.#stage,
        code,
        atMs: this.#now(),
      });
      return { kind: "failed", stage: this.#stage, code };
    } finally {
      input.close();
      this.#closeToIdle();
    }
  }

  async #reason(request: ReasonerRequest, signal: AbortSignal): Promise<void> {
    this.#transition("DEEP_REASONING");
    this.#stage = "reasoner";
    this.#recordAdapter("adapter_started", "reasoner");

    const scope = createChildAbortScope(signal);
    const segments = new BoundedAsyncQueue<string>(16);
    const producer = this.#produceReasonerSegments(
      request,
      scope,
      segments,
    );
    void producer.catch(() => undefined);
    let responseCount = 0;
    try {
      for await (const text of segments) {
        assertNotAborted(signal);
        responseCount += 1;
        await this.#speak(text, signal);
        assertNotAborted(signal);
        this.#transition("DEEP_REASONING");
        this.#stage = "reasoner";
      }
      await producer;
    } finally {
      scope.abort();
      segments.close();
      await producer.catch(() => undefined);
      scope.dispose();
    }

    if (responseCount === 0) {
      throw new VoiceSessionError(
        "reasoner_empty",
        "The text reasoner returned no approved text",
      );
    }

    this.#recordAdapter("adapter_completed", "reasoner");
  }

  async #produceReasonerSegments(
    request: ReasonerRequest,
    scope: ChildAbortScope,
    segments: BoundedAsyncQueue<string>,
  ): Promise<void> {
    try {
      for await (const text of abortable(
        this.dependencies.reasoner.stream(request, { signal: scope.signal }),
        scope.signal,
        this.#timeouts.reasonerMs,
        scope.abort,
      )) {
        assertNotAborted(scope.signal);
        if (text.trim().length === 0) {
          continue;
        }
        await segments.push(text, scope.signal);
      }
      segments.close();
    } catch (error: unknown) {
      segments.fail(error);
      throw error;
    }
  }

  async #speak(text: string, signal: AbortSignal): Promise<void> {
    this.#transition("TTS_STREAMING");
    this.#stage = "tts";
    this.#recordAdapter("adapter_started", "tts");

    const scope = createChildAbortScope(signal);
    const audio = new BoundedAsyncQueue<Uint8Array>(4);
    const producer = this.#produceAudioChunks(text, scope, audio);
    void producer.catch(() => undefined);
    let chunkCount = 0;
    try {
      for await (const audioChunk of audio) {
        assertNotAborted(signal);
        chunkCount += 1;

        this.#transition("SPEAKING");
        this.#stage = "playback";
        this.#recordAdapter("adapter_started", "playback");
        await this.#awaitStage(
          this.dependencies.playback.play(audioChunk, { signal }),
          this.#timeouts.playbackMs,
          signal,
        );
        assertNotAborted(signal);
        this.#recordAdapter("adapter_completed", "playback");

        this.#transition("TTS_STREAMING");
        this.#stage = "tts";
      }
      await producer;
    } finally {
      scope.abort();
      audio.close();
      await producer.catch(() => undefined);
      scope.dispose();
    }

    if (chunkCount === 0) {
      throw new VoiceSessionError("tts_empty", "TTS produced no audio chunks");
    }

    this.#recordAdapter("adapter_completed", "tts");
  }

  async #produceAudioChunks(
    text: string,
    scope: ChildAbortScope,
    audio: BoundedAsyncQueue<Uint8Array>,
  ): Promise<void> {
    let isFirstChunk = true;
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flushPending = async (): Promise<void> => {
      if (pendingBytes === 0) {
        return;
      }
      await audio.push(concatenateAudio(pending, pendingBytes), scope.signal);
      pending = [];
      pendingBytes = 0;
    };

    try {
      for await (const chunk of abortable(
        this.dependencies.tts.synthesize(text, { signal: scope.signal }),
        scope.signal,
        this.#timeouts.ttsMs,
        scope.abort,
      )) {
        assertNotAborted(scope.signal);
        for (let offset = 0; offset < chunk.byteLength; ) {
          const end = Math.min(
            offset + maximumPlaybackBatchBytes,
            chunk.byteLength,
          );
          const slice = chunk.slice(offset, end);
          offset = end;
          if (slice.byteLength === 0) {
            continue;
          }
          if (isFirstChunk) {
            isFirstChunk = false;
            await audio.push(slice, scope.signal);
            continue;
          }
          if (pendingBytes + slice.byteLength > maximumPlaybackBatchBytes) {
            await flushPending();
          }
          pending.push(slice);
          pendingBytes += slice.byteLength;
          if (pendingBytes === maximumPlaybackBatchBytes) {
            await flushPending();
          }
        }
      }
      await flushPending();
      audio.close();
    } catch (error: unknown) {
      audio.fail(error);
      throw error;
    }
  }

  #reasonerRequest(
    finalTranscript: string,
    sessionSummary: string | undefined,
  ): ReasonerRequest {
    if (sessionSummary === undefined) {
      return { finalTranscript };
    }

    return { finalTranscript, sessionSummary };
  }

  #recordAdapter(
    type: Extract<SafeMetricEvent["type"], "adapter_started" | "adapter_completed">,
    stage: SessionStage,
  ): void {
    this.#metrics.record({
      type,
      sessionId: this.dependencies.sessionId,
      stage,
      atMs: this.#now(),
    });
  }

  async #awaitStage<T>(
    promise: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await raceWithAbortAndTimeout(promise, signal, timeoutMs);
    } catch (error: unknown) {
      if (error instanceof SessionTimeoutError) {
        this.#controller?.abort();
      }
      throw error;
    }
  }

  #transition(nextState: SessionState): void {
    const currentState = this.#state;
    if (!allowedTransitions[currentState].includes(nextState)) {
      throw new VoiceSessionError(
        "invalid_transition",
        `Cannot transition from ${currentState} to ${nextState}`,
      );
    }

    this.#state = nextState;
    this.#metrics.record({
      type: "state_changed",
      sessionId: this.dependencies.sessionId,
      from: currentState,
      to: nextState,
      atMs: this.#now(),
    });
  }

  #closeToIdle(): void {
    if (this.#state !== "CLOSING" && this.#state !== "IDLE") {
      this.#transition("CLOSING");
    }

    if (this.#state === "CLOSING") {
      this.#transition("IDLE");
    }
  }
}

function concatenateAudio(
  chunks: readonly Uint8Array[],
  byteLength: number,
): Uint8Array {
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

interface ChildAbortScope {
  readonly signal: AbortSignal;
  readonly abort: () => void;
  readonly dispose: () => void;
}

function createChildAbortScope(parentSignal: AbortSignal): ChildAbortScope {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (parentSignal.aborted) {
    controller.abort();
  } else {
    parentSignal.addEventListener("abort", forwardAbort, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parentSignal.removeEventListener("abort", forwardAbort),
  };
}

async function* abortable<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
  timeoutMs: number,
  onTimeout: () => void,
): AsyncIterable<T> {
  const iterator = source[Symbol.asyncIterator]();
  let exhausted = false;

  try {
    while (true) {
      const next = await raceWithAbortAndTimeout(
        iterator.next(),
        signal,
        timeoutMs,
      );
      if (next.done) {
        exhausted = true;
        return;
      }

      yield next.value;
    }
  } catch (error: unknown) {
    if (error instanceof SessionTimeoutError) {
      onTimeout();
    }
    throw error;
  } finally {
    if (!exhausted) {
      const close = iterator.return?.();
      if (close !== undefined) {
        void close.catch(() => undefined);
      }
    }
  }
}

function resolveTimeouts(
  overrides: Partial<SessionTimeouts> | undefined,
): SessionTimeouts {
  const resolved = { ...defaultTimeouts, ...overrides };
  for (const timeoutMs of Object.values(resolved)) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new VoiceSessionError(
        "invalid_transition",
        "Each session timeout must be a positive integer",
      );
    }
  }

  return resolved;
}
