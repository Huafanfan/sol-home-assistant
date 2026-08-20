import type { SessionOutcome } from "../../../../packages/voice-session/src/index.js";

import {
  assertSatelliteFrame,
  SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION,
  SatelliteMessageKind,
  type SatelliteFrame,
} from "./protocol.js";

export type LocalActivationRuntimeState =
  | "stopped"
  | "local_listening"
  | "awake_local"
  | "asr_streaming"
  | "closing";

export type LocalActivationRuntimeErrorCode =
  | "invalid_state"
  | "invalid_sequence"
  | "unsupported_protocol"
  | "session_error";

const safeRuntimeMessages: Readonly<
  Record<LocalActivationRuntimeErrorCode, string>
> = {
  invalid_state: "Local activation operation is invalid in the current state",
  invalid_sequence: "Local activation event order is invalid",
  unsupported_protocol: "Local activation requires the explicit v2 protocol",
  session_error: "Local activation could not safely continue the voice session",
};

export class LocalActivationRuntimeError extends Error {
  public constructor(public readonly code: LocalActivationRuntimeErrorCode) {
    super(safeRuntimeMessages[code]);
    this.name = "LocalActivationRuntimeError";
  }
}

/**
 * This deliberately narrow interface keeps the local activation gate testable
 * without constructing provider adapters. VoiceSession satisfies it directly.
 */
export interface LocalActivationSession {
  begin(): Promise<SessionOutcome>;
  pushAudio(frame: Uint8Array): void;
  endAudio(): void;
  interrupt(): Promise<SessionOutcome | undefined>;
}

export interface LocalActivationGateway {
  createSession(): LocalActivationSession;
}

export type LocalActivationRuntimeMetric =
  | {
      readonly type: "state_changed";
      readonly from: LocalActivationRuntimeState;
      readonly to: LocalActivationRuntimeState;
    }
  | {
      readonly type: "local_event";
      readonly event:
        | "wake_detected"
        | "speech_started"
        | "speech_ended"
        | "false_wake"
        | "listening_stopped";
    }
  | {
      readonly type: "audio_forwarded";
      readonly frameCount: number;
      readonly byteCount: number;
      readonly durationMs: number;
    };

export interface LocalActivationRuntimeOptions {
  readonly gateway: LocalActivationGateway;
  readonly recordMetric?: (metric: LocalActivationRuntimeMetric) => void;
}

interface ActiveTurn {
  readonly session: LocalActivationSession;
  readonly completion: Promise<SessionOutcome>;
  acceptingAudio: boolean;
  inputOpen: boolean;
  frameCount: number;
  byteCount: number;
}

const localActivationSatelliteKinds = new Set<number>([
  SatelliteMessageKind.localListeningStarted,
  SatelliteMessageKind.wakeDetected,
  SatelliteMessageKind.speechStarted,
  SatelliteMessageKind.audioInput,
  SatelliteMessageKind.speechEnded,
  SatelliteMessageKind.localListeningStopped,
  SatelliteMessageKind.wakeTimedOut,
  SatelliteMessageKind.cancelled,
  SatelliteMessageKind.deviceChanged,
  SatelliteMessageKind.error,
]);

/**
 * Gateway-side privacy gate for the v2 local-activation stream. It is passive:
 * a transport/client may hand it validated Satellite frames, but it owns the
 * critical rule that no VoiceSession is created until `speechStarted` arrives.
 */
export class LocalActivationRuntime {
  readonly #gateway: LocalActivationGateway;
  readonly #recordMetric: (metric: LocalActivationRuntimeMetric) => void;

  #state: LocalActivationRuntimeState = "stopped";
  #listeningEnabled = false;
  #active: ActiveTurn | undefined;

  public constructor(options: LocalActivationRuntimeOptions) {
    this.#gateway = options.gateway;
    this.#recordMetric = options.recordMetric ?? (() => undefined);
  }

  public get state(): LocalActivationRuntimeState {
    return this.#state;
  }

  /** The caller has obtained user intent and may now request local listening. */
  public startLocalListening(): void {
    this.#requireState("stopped");
    this.#listeningEnabled = true;
    this.#transition("local_listening");
  }

  /**
   * Performs only local state cleanup here. The future transport adapter owns
   * sending `stopLocalListening` to the Satellite.
   */
  public async stopLocalListening(): Promise<void> {
    this.#listeningEnabled = false;
    const active = this.#active;
    if (active !== undefined) {
      active.acceptingAudio = false;
      active.inputOpen = false;
      this.#active = undefined;
      await active.session.interrupt().catch(() => undefined);
    }
    if (this.#state !== "stopped") {
      this.#transition("stopped");
    }
    this.#recordMetric({ type: "local_event", event: "listening_stopped" });
  }

  /**
   * Accepts only Satellite->Gateway v2 activation frames. Any frame before
   * speech_started is either an event with no side effect or a safe sequence
   * rejection; it cannot allocate a VoiceSession or forward PCM.
   */
  public handleSatelliteFrame(frame: SatelliteFrame): void {
    this.#assertActivationFrame(frame);

    switch (frame.kind) {
      case SatelliteMessageKind.localListeningStarted:
        this.#requireState("local_listening");
        return;
      case SatelliteMessageKind.wakeDetected:
        this.#requireState("local_listening");
        this.#transition("awake_local");
        this.#recordMetric({ type: "local_event", event: "wake_detected" });
        return;
      case SatelliteMessageKind.wakeTimedOut:
        this.#requireState("awake_local");
        this.#transition("local_listening");
        this.#recordMetric({ type: "local_event", event: "false_wake" });
        return;
      case SatelliteMessageKind.speechStarted:
        this.#requireState("awake_local");
        this.#beginTurn();
        this.#recordMetric({ type: "local_event", event: "speech_started" });
        return;
      case SatelliteMessageKind.audioInput:
        this.#forwardAudio(frame.payload);
        return;
      case SatelliteMessageKind.speechEnded:
        this.#endAudio();
        this.#recordMetric({ type: "local_event", event: "speech_ended" });
        return;
      case SatelliteMessageKind.localListeningStopped:
      case SatelliteMessageKind.cancelled:
      case SatelliteMessageKind.deviceChanged:
      case SatelliteMessageKind.error:
        this.#stopFromSatellite();
        return;
      default:
        throw new LocalActivationRuntimeError("invalid_sequence");
    }
  }

  #assertActivationFrame(frame: SatelliteFrame): void {
    if (frame.version !== SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION) {
      throw new LocalActivationRuntimeError("unsupported_protocol");
    }
    assertSatelliteFrame(frame);
    if (!localActivationSatelliteKinds.has(frame.kind)) {
      throw new LocalActivationRuntimeError("invalid_sequence");
    }
  }

  #beginTurn(): void {
    let session: LocalActivationSession;
    let completion: Promise<SessionOutcome>;
    try {
      session = this.#gateway.createSession();
      completion = session.begin();
    } catch {
      throw new LocalActivationRuntimeError("session_error");
    }

    const turn: ActiveTurn = {
      session,
      completion,
      acceptingAudio: true,
      inputOpen: true,
      frameCount: 0,
      byteCount: 0,
    };
    this.#active = turn;
    this.#transition("asr_streaming");
    void this.#watchCompletion(turn);
  }

  #forwardAudio(frame: Uint8Array): void {
    const turn = this.#active;
    if (
      turn === undefined ||
      !turn.acceptingAudio ||
      !turn.inputOpen ||
      this.#state !== "asr_streaming"
    ) {
      throw new LocalActivationRuntimeError("invalid_sequence");
    }

    try {
      turn.session.pushAudio(frame);
    } catch {
      this.#stopFromSatellite();
      throw new LocalActivationRuntimeError("session_error");
    }

    turn.frameCount += 1;
    turn.byteCount += frame.byteLength;
    this.#recordMetric({
      type: "audio_forwarded",
      frameCount: turn.frameCount,
      byteCount: turn.byteCount,
      durationMs: Math.floor(turn.byteCount / 32),
    });
  }

  #endAudio(): void {
    const turn = this.#active;
    if (
      turn === undefined ||
      !turn.inputOpen ||
      this.#state !== "asr_streaming"
    ) {
      throw new LocalActivationRuntimeError("invalid_sequence");
    }

    turn.acceptingAudio = false;
    turn.inputOpen = false;
    try {
      turn.session.endAudio();
    } catch {
      this.#stopFromSatellite();
      throw new LocalActivationRuntimeError("session_error");
    }
    this.#transition("closing");
  }

  #stopFromSatellite(): void {
    this.#listeningEnabled = false;
    const active = this.#active;
    this.#active = undefined;
    if (active !== undefined) {
      active.acceptingAudio = false;
      active.inputOpen = false;
      void active.session.interrupt().catch(() => undefined);
    }
    if (this.#state !== "stopped") {
      this.#transition("stopped");
    }
    this.#recordMetric({ type: "local_event", event: "listening_stopped" });
  }

  async #watchCompletion(turn: ActiveTurn): Promise<void> {
    await turn.completion.catch(() => undefined);
    turn.acceptingAudio = false;
    turn.inputOpen = false;
    if (this.#active !== turn) {
      return;
    }
    this.#active = undefined;
    this.#transition(this.#listeningEnabled ? "local_listening" : "stopped");
  }

  #requireState(expected: LocalActivationRuntimeState): void {
    if (this.#state !== expected) {
      throw new LocalActivationRuntimeError("invalid_state");
    }
  }

  #transition(next: LocalActivationRuntimeState): void {
    const previous = this.#state;
    this.#state = next;
    this.#recordMetric({ type: "state_changed", from: previous, to: next });
  }
}
