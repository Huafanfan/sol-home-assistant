import type {
  AsrAdapter,
  AsrFinalResult,
  PlaybackAdapter,
  ReasonerAdapter,
  ReasonerRequest,
  ResponsePlan,
  ResponseRouter,
  RouteRequest,
  TtsAdapter,
} from "./contracts.js";
import { assertNotAborted } from "./errors.js";

/** Deterministic adapters for the local demo and automated tests only. */
export class ScriptedAsr implements AsrAdapter {
  public calls = 0;
  public frameCount = 0;

  public constructor(private readonly finalTranscript: string) {}

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
      assertNotAborted(options.signal);
      this.frameCount += 1;
      options.onPartialTranscript({ characterCount: frame.byteLength });
    }

    assertNotAborted(options.signal);
    return { finalTranscript: this.finalTranscript };
  }
}

export class StaticRouter implements ResponseRouter {
  public readonly requests: RouteRequest[] = [];

  public constructor(private readonly plan: ResponsePlan) {}

  public async route(
    request: RouteRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ResponsePlan> {
    assertNotAborted(options.signal);
    this.requests.push(request);
    return this.plan;
  }
}

export class StaticReasoner implements ReasonerAdapter {
  public readonly requests: ReasonerRequest[] = [];

  public constructor(private readonly textChunks: readonly string[]) {}

  public async *stream(
    request: ReasonerRequest,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<string> {
    this.requests.push(request);
    for (const chunk of this.textChunks) {
      assertNotAborted(options.signal);
      yield chunk;
    }
  }
}

export class StaticTts implements TtsAdapter {
  public calls = 0;
  public readonly inputCharacterCounts: number[] = [];

  public constructor(
    private readonly audioChunks: readonly Uint8Array[] = [new Uint8Array([1])],
  ) {}

  public async *synthesize(
    text: string,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<Uint8Array> {
    this.calls += 1;
    this.inputCharacterCounts.push(text.length);
    for (const chunk of this.audioChunks) {
      assertNotAborted(options.signal);
      yield chunk;
    }
  }
}

export class RecordingPlayback implements PlaybackAdapter {
  public playedChunkCount = 0;
  public playedByteCount = 0;

  public async play(
    audio: Uint8Array,
    options: { readonly signal: AbortSignal },
  ): Promise<void> {
    assertNotAborted(options.signal);
    this.playedChunkCount += 1;
    this.playedByteCount += audio.byteLength;
  }
}
