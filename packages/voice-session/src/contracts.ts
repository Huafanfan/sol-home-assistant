export type SessionState =
  | "IDLE"
  | "AWAKE"
  | "ASR_STREAMING"
  | "ROUTING"
  | "DEEP_REASONING"
  | "TTS_STREAMING"
  | "SPEAKING"
  | "FALLBACK"
  | "CLOSING";

export type SessionStage =
  | "session"
  | "asr"
  | "router"
  | "reasoner"
  | "tts"
  | "playback";

export type FailureCode =
  | "audio_before_activation"
  | "audio_after_input_closed"
  | "invalid_transition"
  | "asr_timeout"
  | "asr_error"
  | "router_timeout"
  | "router_error"
  | "reasoner_timeout"
  | "reasoner_error"
  | "reasoner_empty"
  | "tts_timeout"
  | "tts_error"
  | "tts_empty"
  | "playback_timeout"
  | "playback_error"
  | "interrupted"
  | "unknown_error";

export interface AsrFinalResult {
  readonly finalTranscript: string;
}

export interface AsrRunOptions {
  readonly signal: AbortSignal;
  readonly onPartialTranscript: (event: {
    readonly characterCount: number;
  }) => void;
}

export interface AsrAdapter {
  transcribe(
    audio: AsyncIterable<Uint8Array>,
    options: AsrRunOptions,
  ): Promise<AsrFinalResult>;
}

export interface RouteRequest {
  readonly finalTranscript: string;
}

export type ResponsePlan =
  | {
      readonly kind: "direct";
      readonly text: string;
    }
  | {
      readonly kind: "reason";
      readonly sessionSummary?: string;
    };

export interface ResponseRouter {
  route(
    request: RouteRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ResponsePlan>;
}

export interface ReasonerRequest {
  readonly finalTranscript: string;
  readonly sessionSummary?: string;
}

export interface ReasonerAdapter {
  stream(
    request: ReasonerRequest,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<string>;
}

export interface TtsAdapter {
  synthesize(
    text: string,
    options: { readonly signal: AbortSignal },
  ): AsyncIterable<Uint8Array>;
}

export interface PlaybackAdapter {
  play(
    audio: Uint8Array,
    options: { readonly signal: AbortSignal },
  ): Promise<void>;
}

export type SafeMetricEvent =
  | {
      readonly type: "state_changed";
      readonly sessionId: string;
      readonly from: SessionState;
      readonly to: SessionState;
      readonly atMs: number;
    }
  | {
      readonly type: "partial_transcript";
      readonly sessionId: string;
      readonly characterCount: number;
      readonly atMs: number;
    }
  | {
      readonly type: "adapter_started" | "adapter_completed";
      readonly sessionId: string;
      readonly stage: SessionStage;
      readonly atMs: number;
    }
  | {
      readonly type: "interrupted";
      readonly sessionId: string;
      readonly stage: SessionStage;
      readonly atMs: number;
    }
  | {
      readonly type: "failed";
      readonly sessionId: string;
      readonly stage: SessionStage;
      readonly code: FailureCode;
      readonly atMs: number;
    };

export interface MetricsSink {
  record(event: SafeMetricEvent): void;
}

export interface SessionTimeouts {
  readonly asrMs: number;
  readonly routerMs: number;
  readonly reasonerMs: number;
  readonly ttsMs: number;
  readonly playbackMs: number;
}

export interface VoiceSessionDependencies {
  readonly sessionId: string;
  readonly asr: AsrAdapter;
  readonly router: ResponseRouter;
  readonly reasoner: ReasonerAdapter;
  readonly tts: TtsAdapter;
  readonly playback: PlaybackAdapter;
  readonly metrics?: MetricsSink;
  readonly now?: () => number;
  readonly timeouts?: Partial<SessionTimeouts>;
}

export type SessionOutcome =
  | { readonly kind: "completed" }
  | {
      readonly kind: "interrupted";
      readonly stage: SessionStage;
    }
  | {
      readonly kind: "failed";
      readonly stage: SessionStage;
      readonly code: FailureCode;
    };
