import assert from "node:assert/strict";
import test from "node:test";

import type { SessionOutcome } from "../packages/voice-session/src/index.js";
import {
  LocalActivationRuntime,
  LocalActivationRuntimeError,
  type LocalActivationSession,
} from "../apps/voice-gateway/src/satellite/local-activation.js";
import {
  SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION,
  SatelliteMessageKind,
  type SatelliteFrame,
  type SatelliteMessageKind as SatelliteMessageKindType,
} from "../apps/voice-gateway/src/satellite/protocol.js";

function activationFrame(
  kind: SatelliteMessageKindType,
  payload = new Uint8Array(),
): SatelliteFrame {
  return {
    version: SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION,
    kind,
    payload,
  };
}

test("local activation creates a session only after speech_started", async () => {
  const session = new FakeActivationSession();
  let createCalls = 0;
  const runtime = new LocalActivationRuntime({
    gateway: {
      createSession: () => {
        createCalls += 1;
        return session;
      },
    },
  });

  runtime.startLocalListening();
  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.localListeningStarted),
  );
  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.wakeDetected),
  );

  assert.equal(runtime.state, "awake_local");
  assert.equal(createCalls, 0);
  assert.throws(
    () =>
      runtime.handleSatelliteFrame(
        activationFrame(SatelliteMessageKind.audioInput, Uint8Array.of(2, 0)),
      ),
    (error: unknown) =>
      error instanceof LocalActivationRuntimeError &&
      error.code === "invalid_sequence",
  );
  assert.equal(createCalls, 0);
  assert.deepEqual(session.audio, []);

  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.speechStarted),
  );
  assert.equal(runtime.state, "asr_streaming");
  assert.equal(createCalls, 1);
  assert.equal(session.beginCalls, 1);

  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.audioInput, Uint8Array.of(2, 0, 3, 0)),
  );
  assert.deepEqual(session.audio, [Uint8Array.of(2, 0, 3, 0)]);

  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.speechEnded),
  );
  assert.equal(session.endAudioCalls, 1);
  assert.equal(runtime.state, "closing");

  session.complete({ kind: "completed" });
  await settle();
  assert.equal(runtime.state, "local_listening");
});

test("false wakes and v1 frames cannot create an ASR session", () => {
  const session = new FakeActivationSession();
  let createCalls = 0;
  const runtime = new LocalActivationRuntime({
    gateway: {
      createSession: () => {
        createCalls += 1;
        return session;
      },
    },
  });

  runtime.startLocalListening();
  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.wakeDetected),
  );
  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.wakeTimedOut),
  );

  assert.equal(runtime.state, "local_listening");
  assert.equal(createCalls, 0);
  assert.throws(
    () =>
      runtime.handleSatelliteFrame({
        kind: SatelliteMessageKind.wakeDetected,
        payload: new Uint8Array(),
      }),
    (error: unknown) =>
      error instanceof LocalActivationRuntimeError &&
      error.code === "unsupported_protocol",
  );
  assert.equal(createCalls, 0);
});

test("local stop clears the gate and never starts a replacement session", async () => {
  const session = new FakeActivationSession();
  const runtime = new LocalActivationRuntime({
    gateway: { createSession: () => session },
  });

  runtime.startLocalListening();
  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.wakeDetected),
  );
  runtime.handleSatelliteFrame(
    activationFrame(SatelliteMessageKind.speechStarted),
  );
  await runtime.stopLocalListening();

  assert.equal(runtime.state, "stopped");
  assert.equal(session.interruptCalls, 1);
  assert.equal(session.beginCalls, 1);
});

class FakeActivationSession implements LocalActivationSession {
  readonly audio: Uint8Array[] = [];
  #resolve: ((outcome: SessionOutcome) => void) | undefined;
  readonly completion = new Promise<SessionOutcome>((resolve) => {
    this.#resolve = resolve;
  });

  beginCalls = 0;
  endAudioCalls = 0;
  interruptCalls = 0;

  public begin(): Promise<SessionOutcome> {
    this.beginCalls += 1;
    return this.completion;
  }

  public pushAudio(frame: Uint8Array): void {
    this.audio.push(frame);
  }

  public endAudio(): void {
    this.endAudioCalls += 1;
  }

  public async interrupt(): Promise<SessionOutcome | undefined> {
    this.interruptCalls += 1;
    return undefined;
  }

  public complete(outcome: SessionOutcome): void {
    this.#resolve?.(outcome);
  }
}

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
