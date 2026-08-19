import type { PlaybackAdapter } from "../../../../packages/voice-session/src/index.js";

import {
  assertGatewayFrame,
  assertSatelliteFrame,
  encodeCaptureDuration,
  encodeSatelliteFrame,
  SatelliteFrameDecoder,
  SatelliteMessageKind,
  type SatelliteFrame,
  type SatelliteMessageKind as SatelliteMessageKindType,
} from "./protocol.js";
import type { SatelliteTransport } from "./process-transport.js";

export type MacosSatellitePermissionState =
  | "not_determined"
  | "authorized"
  | "denied"
  | "restricted";

export type MacosSatelliteClientState =
  | "starting"
  | "hello_received"
  | "awaiting_permission"
  | "permission_blocked"
  | "ready"
  | "starting_capture"
  | "capturing"
  | "stopping_capture"
  | "starting_playback"
  | "playing"
  | "cancelling"
  | "stopping"
  | "closed"
  | "failed";

export type MacosSatelliteClientErrorCode =
  | "invalid_state"
  | "unexpected_message"
  | "operation_timeout"
  | "operation_cancelled"
  | "satellite_error"
  | "transport_closed"
  | "transport_write_failed";

const safeClientMessages: Readonly<Record<MacosSatelliteClientErrorCode, string>> = {
  invalid_state: "Satellite operation is invalid in the current state",
  unexpected_message: "Satellite sent an unexpected protocol message",
  operation_timeout: "Satellite operation timed out",
  operation_cancelled: "Satellite operation was cancelled",
  satellite_error: "Satellite reported a safe protocol error",
  transport_closed: "Satellite transport closed unexpectedly",
  transport_write_failed: "Satellite transport write failed",
};

export class MacosSatelliteClientError extends Error {
  public constructor(public readonly code: MacosSatelliteClientErrorCode) {
    super(safeClientMessages[code]);
    this.name = "MacosSatelliteClientError";
  }
}

export type MacosSatelliteMetric =
  | {
      readonly type: "state_changed";
      readonly from: MacosSatelliteClientState;
      readonly to: MacosSatelliteClientState;
    }
  | {
      readonly type: "frame_received" | "frame_sent";
      readonly kind: SatelliteMessageKindType;
      readonly byteCount: number;
    }
  | {
      readonly type: "permission_state";
      readonly state: MacosSatellitePermissionState;
    }
  | { readonly type: "playback_finished"; readonly reason: number }
  | { readonly type: "protocol_failed"; readonly code: string };

export interface MacosSatelliteClientOptions {
  readonly transport: SatelliteTransport;
  readonly operationTimeoutMs?: number;
  readonly recordMetric?: (metric: MacosSatelliteMetric) => void;
}

interface FrameWaiter {
  readonly kind: SatelliteMessageKindType;
  readonly resolve: (frame: SatelliteFrame) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
}

export class MacosSatelliteClient implements PlaybackAdapter {
  readonly #transport: SatelliteTransport;
  readonly #operationTimeoutMs: number;
  readonly #recordMetric: (metric: MacosSatelliteMetric) => void;
  readonly #decoder = new SatelliteFrameDecoder();
  readonly #waiters = new Set<FrameWaiter>();
  readonly #listeners = new Set<(frame: SatelliteFrame) => void>();

  #state: MacosSatelliteClientState = "starting";
  #permission: MacosSatellitePermissionState = "not_determined";
  #pump: Promise<void> | undefined;
  #cancelPromise: Promise<void> | undefined;

  public constructor(options: MacosSatelliteClientOptions) {
    this.#transport = options.transport;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 5_000;
    if (
      !Number.isInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs < 1
    ) {
      throw new MacosSatelliteClientError("invalid_state");
    }
    this.#recordMetric = options.recordMetric ?? (() => undefined);
  }

  public get state(): MacosSatelliteClientState {
    return this.#state;
  }

  public get permission(): MacosSatellitePermissionState {
    return this.#permission;
  }

  public subscribe(listener: (frame: SatelliteFrame) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  public async initialize(): Promise<MacosSatellitePermissionState> {
    if (this.#pump !== undefined || this.#state !== "starting") {
      throw new MacosSatelliteClientError("invalid_state");
    }
    this.#pump = this.#readFrames();
    await this.#waitFor(SatelliteMessageKind.hello);
    this.#transition("awaiting_permission");
    const permissionFrame = await this.#exchange(
      { kind: SatelliteMessageKind.requestPermission, payload: new Uint8Array() },
      SatelliteMessageKind.permissionState,
    );
    this.#permission = decodePermission(permissionFrame.payload[0]);
    this.#recordMetric({ type: "permission_state", state: this.#permission });
    this.#transition(
      this.#permission === "authorized" ? "ready" : "permission_blocked",
    );
    return this.#permission;
  }

  public async startCapture(durationMs = 15_000): Promise<void> {
    this.#requireState("ready");
    this.#transition("starting_capture");
    try {
      await this.#exchange(
        {
          kind: SatelliteMessageKind.startCapture,
          payload: encodeCaptureDuration(durationMs),
        },
        SatelliteMessageKind.captureStarted,
      );
    } catch (error) {
      this.#transition("failed");
      throw error;
    }
  }

  public async stopCapture(): Promise<void> {
    this.#requireState("capturing");
    this.#transition("stopping_capture");
    await this.#exchange(
      { kind: SatelliteMessageKind.stopCapture, payload: new Uint8Array() },
      SatelliteMessageKind.captureStopped,
    );
  }

  public async play(
    audio: Uint8Array,
    options: { readonly signal: AbortSignal },
  ): Promise<void> {
    this.#requireState("ready");
    if (options.signal.aborted) {
      throw new MacosSatelliteClientError("operation_cancelled");
    }
    this.#transition("starting_playback");
    try {
      const responses = Promise.all([
        this.#waitFor(SatelliteMessageKind.playbackStarted, options.signal),
        this.#waitFor(SatelliteMessageKind.playbackFinished, options.signal),
      ]);
      void responses.catch(() => undefined);
      await this.#send({ kind: SatelliteMessageKind.playAudio, payload: audio });
      const [, finished] = await responses;
      this.#recordMetric({
        type: "playback_finished",
        reason: finished.payload[0] ?? 2,
      });
      if (finished.payload[0] !== 0) {
        throw new MacosSatelliteClientError("satellite_error");
      }
    } catch (error) {
      if (options.signal.aborted) {
        await this.cancel().catch(() => undefined);
        throw new MacosSatelliteClientError("operation_cancelled");
      }
      throw error;
    }
  }

  public async cancel(): Promise<void> {
    if (
      this.#state === "ready" ||
      this.#state === "permission_blocked" ||
      this.#state === "closed"
    ) {
      return;
    }
    if (this.#cancelPromise !== undefined) {
      return this.#cancelPromise;
    }
    this.#cancelPromise = this.#performCancel();
    try {
      await this.#cancelPromise;
    } finally {
      this.#cancelPromise = undefined;
    }
  }

  public async shutdown(): Promise<void> {
    if (this.#state === "closed") {
      return;
    }
    if (isActiveState(this.#state)) {
      await this.cancel();
    }
    if (this.#state !== "ready" && this.#state !== "permission_blocked") {
      throw new MacosSatelliteClientError("invalid_state");
    }
    this.#transition("stopping");
    await this.#exchange(
      { kind: SatelliteMessageKind.shutdown, payload: new Uint8Array() },
      SatelliteMessageKind.shutdownComplete,
    );
    this.#transport.closeInput();
  }

  async #performCancel(): Promise<void> {
    this.#transition("cancelling");
    await this.#exchange(
      { kind: SatelliteMessageKind.cancel, payload: new Uint8Array() },
      SatelliteMessageKind.cancelled,
    );
  }

  async #exchange(
    outgoing: SatelliteFrame,
    expectedKind: SatelliteMessageKindType,
    signal?: AbortSignal,
  ): Promise<SatelliteFrame> {
    const response = this.#waitFor(expectedKind, signal);
    try {
      await this.#send(outgoing);
    } catch (error) {
      this.#failWaiters(asError(error));
      if (this.#state !== "closed") {
        this.#transition("failed");
      }
      void response.catch(() => undefined);
      throw error;
    }
    return response;
  }

  async #send(frame: SatelliteFrame): Promise<void> {
    assertGatewayFrame(frame);
    const encoded = encodeSatelliteFrame(frame);
    try {
      await this.#transport.write(encoded);
    } catch {
      throw new MacosSatelliteClientError("transport_write_failed");
    }
    this.#recordMetric({
      type: "frame_sent",
      kind: frame.kind,
      byteCount: frame.payload.byteLength,
    });
  }

  #waitFor(
    kind: SatelliteMessageKindType,
    signal?: AbortSignal,
  ): Promise<SatelliteFrame> {
    if (signal?.aborted === true) {
      return Promise.reject(
        new MacosSatelliteClientError("operation_cancelled"),
      );
    }
    return new Promise<SatelliteFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters.delete(waiter);
        cleanupSignal();
        reject(new MacosSatelliteClientError("operation_timeout"));
      }, this.#operationTimeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.#waiters.delete(waiter);
        reject(new MacosSatelliteClientError("operation_cancelled"));
      };
      const cleanupSignal = () => signal?.removeEventListener("abort", onAbort);
      const waiter: FrameWaiter = {
        kind,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          cleanupSignal();
        },
      };
      this.#waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async #readFrames(): Promise<void> {
    try {
      for await (const chunk of this.#transport.output) {
        for (const frame of this.#decoder.push(chunk)) {
          assertSatelliteFrame(frame);
          this.#acceptFrame(frame);
          this.#recordMetric({
            type: "frame_received",
            kind: frame.kind,
            byteCount: frame.payload.byteLength,
          });
          this.#dispatch(frame);
        }
      }
      this.#decoder.finish();
      if (this.#state !== "closed") {
        throw new MacosSatelliteClientError("transport_closed");
      }
    } catch (error) {
      if (this.#state !== "closed") {
        this.#transition("failed");
        this.#failWaiters(asError(error));
      }
    }
  }

  #acceptFrame(frame: SatelliteFrame): void {
    switch (frame.kind) {
      case SatelliteMessageKind.hello:
        this.#requireState("starting");
        this.#transition("hello_received");
        return;
      case SatelliteMessageKind.permissionState:
        this.#requireState("awaiting_permission");
        return;
      case SatelliteMessageKind.captureStarted:
        this.#requireState("starting_capture");
        this.#transition("capturing");
        return;
      case SatelliteMessageKind.audioInput:
        if (this.#state !== "capturing" && this.#state !== "stopping_capture") {
          throw new MacosSatelliteClientError("unexpected_message");
        }
        return;
      case SatelliteMessageKind.captureStopped:
        if (
          this.#state !== "capturing" &&
          this.#state !== "stopping_capture" &&
          this.#state !== "cancelling"
        ) {
          throw new MacosSatelliteClientError("unexpected_message");
        }
        if (this.#state !== "cancelling") {
          this.#transition("ready");
        }
        return;
      case SatelliteMessageKind.playbackStarted:
        this.#requireState("starting_playback");
        this.#transition("playing");
        return;
      case SatelliteMessageKind.playbackFinished:
        if (this.#state !== "playing" && this.#state !== "cancelling") {
          throw new MacosSatelliteClientError("unexpected_message");
        }
        if (this.#state !== "cancelling") {
          this.#transition("ready");
        }
        return;
      case SatelliteMessageKind.cancelled:
        this.#requireState("cancelling");
        this.#transition(
          this.#permission === "authorized" ? "ready" : "permission_blocked",
        );
        return;
      case SatelliteMessageKind.deviceChanged:
        if (this.#state === "closed" || this.#state === "stopping") {
          throw new MacosSatelliteClientError("unexpected_message");
        }
        return;
      case SatelliteMessageKind.error:
        this.#recordMetric({ type: "protocol_failed", code: "satellite_error" });
        throw new MacosSatelliteClientError("satellite_error");
      case SatelliteMessageKind.shutdownComplete:
        this.#requireState("stopping");
        this.#transition("closed");
        return;
      default:
        throw new MacosSatelliteClientError("unexpected_message");
    }
  }

  #dispatch(frame: SatelliteFrame): void {
    for (const listener of this.#listeners) {
      listener(frame);
    }
    for (const waiter of this.#waiters) {
      if (waiter.kind !== frame.kind) {
        continue;
      }
      this.#waiters.delete(waiter);
      waiter.cleanup();
      waiter.resolve(frame);
      break;
    }
  }

  #failWaiters(error: Error): void {
    for (const waiter of this.#waiters) {
      waiter.cleanup();
      waiter.reject(error);
    }
    this.#waiters.clear();
  }

  #requireState(expected: MacosSatelliteClientState): void {
    if (this.#state !== expected) {
      throw new MacosSatelliteClientError("unexpected_message");
    }
  }

  #transition(next: MacosSatelliteClientState): void {
    const previous = this.#state;
    this.#state = next;
    this.#recordMetric({ type: "state_changed", from: previous, to: next });
  }
}

function decodePermission(raw: number | undefined): MacosSatellitePermissionState {
  switch (raw) {
    case 0:
      return "not_determined";
    case 1:
      return "authorized";
    case 2:
      return "denied";
    case 3:
      return "restricted";
    default:
      throw new MacosSatelliteClientError("unexpected_message");
  }
}

function isActiveState(state: MacosSatelliteClientState): boolean {
  return (
    state === "starting_capture" ||
    state === "capturing" ||
    state === "stopping_capture" ||
    state === "starting_playback" ||
    state === "playing" ||
    state === "cancelling"
  );
}

function asError(error: unknown): Error {
  return error instanceof Error
    ? error
    : new MacosSatelliteClientError("unexpected_message");
}
