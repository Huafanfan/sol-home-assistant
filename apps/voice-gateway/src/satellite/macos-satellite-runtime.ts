import type {
  SessionOutcome,
  VoiceSession,
} from "../../../../packages/voice-session/src/index.js";
import type { VoiceGateway } from "../development-gateway.js";

import { MacosSatelliteClient } from "./macos-satellite-client.js";
import { SatelliteMessageKind, type SatelliteFrame } from "./protocol.js";

export type MacosSatelliteRuntimeState =
  | "stopped"
  | "permission_blocked"
  | "ready"
  | "capturing"
  | "waiting_response"
  | "closing";

export type MacosSatelliteRuntimeMetric =
  | {
      readonly type: "state_changed";
      readonly from: MacosSatelliteRuntimeState;
      readonly to: MacosSatelliteRuntimeState;
    }
  | {
      readonly type: "audio_received";
      readonly frameCount: number;
      readonly byteCount: number;
      readonly durationMs: number;
    }
  | {
      readonly type: "capture_stopped";
      readonly reason: number;
    }
  | { readonly type: "cleanup_completed" };

export interface MacosSatelliteRuntimeOptions {
  readonly client: MacosSatelliteClient;
  readonly gateway: VoiceGateway;
  readonly recordMetric?: (metric: MacosSatelliteRuntimeMetric) => void;
}

interface ActiveTurn {
  readonly session: VoiceSession;
  readonly completion: Promise<SessionOutcome>;
  acceptingAudio: boolean;
  inputOpen: boolean;
  frameCount: number;
  byteCount: number;
}

export class MacosSatelliteRuntime {
  readonly #client: MacosSatelliteClient;
  readonly #gateway: VoiceGateway;
  readonly #recordMetric: (metric: MacosSatelliteRuntimeMetric) => void;
  readonly #unsubscribe: () => void;

  #state: MacosSatelliteRuntimeState = "stopped";
  #active: ActiveTurn | undefined;

  public constructor(options: MacosSatelliteRuntimeOptions) {
    this.#client = options.client;
    this.#gateway = options.gateway;
    this.#recordMetric = options.recordMetric ?? (() => undefined);
    this.#unsubscribe = this.#client.subscribe((frame) =>
      this.#handleFrame(frame),
    );
  }

  public get state(): MacosSatelliteRuntimeState {
    return this.#state;
  }

  public async initialize(): Promise<MacosSatelliteRuntimeState> {
    if (this.#state !== "stopped") {
      throw new Error("Voice Satellite runtime is already initialized");
    }
    const permission = await this.#client.initialize();
    this.#transition(
      permission === "authorized" ? "ready" : "permission_blocked",
    );
    return this.#state;
  }

  public async beginCapture(durationMs = 15_000): Promise<void> {
    if (this.#state !== "ready" || this.#active !== undefined) {
      throw new Error("Voice Satellite runtime is not ready for capture");
    }

    const session = this.#gateway.createSession();
    const completion = session.begin();
    const turn: ActiveTurn = {
      session,
      completion,
      acceptingAudio: true,
      inputOpen: true,
      frameCount: 0,
      byteCount: 0,
    };
    this.#active = turn;
    this.#transition("capturing");
    void this.#watchCompletion(turn);

    try {
      await this.#client.startCapture(durationMs);
    } catch (error) {
      turn.acceptingAudio = false;
      turn.inputOpen = false;
      await session.interrupt();
      if (this.#active === turn) {
        this.#active = undefined;
        this.#transition("ready");
      }
      throw error;
    }
  }

  public async endCapture(): Promise<SessionOutcome | undefined> {
    const turn = this.#active;
    if (turn === undefined) {
      return undefined;
    }
    if (this.#state === "capturing" && turn.inputOpen) {
      await this.#client.stopCapture();
    }
    return turn.completion;
  }

  public async interrupt(): Promise<SessionOutcome | undefined> {
    const turn = this.#active;
    if (turn === undefined) {
      return undefined;
    }
    turn.acceptingAudio = false;
    turn.inputOpen = false;
    this.#transition("closing");
    const [, outcome] = await Promise.all([
      this.#client.cancel(),
      turn.session.interrupt(),
    ]);
    return outcome;
  }

  public async shutdown(): Promise<void> {
    if (this.#active !== undefined) {
      await this.interrupt();
    }
    await this.#client.shutdown();
    this.#unsubscribe();
    this.#transition("stopped");
  }

  #handleFrame(frame: SatelliteFrame): void {
    const turn = this.#active;
    switch (frame.kind) {
      case SatelliteMessageKind.audioInput:
        if (
          turn === undefined ||
          !turn.acceptingAudio ||
          !turn.inputOpen ||
          this.#state !== "capturing"
        ) {
          return;
        }
        turn.frameCount += 1;
        turn.byteCount += frame.payload.byteLength;
        this.#recordMetric({
          type: "audio_received",
          frameCount: turn.frameCount,
          byteCount: turn.byteCount,
          durationMs: Math.floor(turn.byteCount / 32),
        });
        try {
          turn.session.pushAudio(frame.payload);
        } catch {
          turn.acceptingAudio = false;
          turn.inputOpen = false;
          void this.interrupt();
        }
        return;
      case SatelliteMessageKind.captureStopped:
        if (turn === undefined || !turn.inputOpen) {
          return;
        }
        turn.acceptingAudio = false;
        turn.inputOpen = false;
        this.#recordMetric({
          type: "capture_stopped",
          reason: frame.payload[0] ?? 3,
        });
        if (frame.payload[0] === 0 || frame.payload[0] === 1) {
          this.#transition("waiting_response");
          try {
            turn.session.endAudio();
          } catch {
            void this.interrupt();
          }
        } else {
          void this.interrupt();
        }
        return;
      case SatelliteMessageKind.deviceChanged:
      case SatelliteMessageKind.error:
        if (turn !== undefined) {
          turn.acceptingAudio = false;
          turn.inputOpen = false;
          void this.interrupt();
        }
        return;
      default:
        return;
    }
  }

  async #watchCompletion(turn: ActiveTurn): Promise<void> {
    await turn.completion;
    turn.acceptingAudio = false;
    turn.inputOpen = false;
    if (this.#active !== turn) {
      return;
    }
    if (
      this.#client.state !== "ready" &&
      this.#client.state !== "permission_blocked" &&
      this.#client.state !== "closed"
    ) {
      await this.#client.cancel().catch(() => undefined);
    }
    if (this.#active === turn) {
      this.#active = undefined;
      this.#transition("ready");
      this.#recordMetric({ type: "cleanup_completed" });
    }
  }

  #requireActiveTurn(): ActiveTurn {
    if (this.#active === undefined) {
      throw new Error("Voice Satellite has no active turn");
    }
    return this.#active;
  }

  #transition(next: MacosSatelliteRuntimeState): void {
    const previous = this.#state;
    this.#state = next;
    this.#recordMetric({ type: "state_changed", from: previous, to: next });
  }
}
