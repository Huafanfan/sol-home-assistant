import assert from "node:assert/strict";
import test from "node:test";

import {
  assertGatewayFrame,
  assertSatelliteFrame,
  encodeCaptureDuration,
  encodeSatelliteFrame,
  MAX_SATELLITE_AUDIO_BYTES,
  SatelliteFrameDecoder,
  SatelliteMessageKind,
  SatelliteProtocolError,
} from "../apps/voice-gateway/src/satellite/protocol.js";

test("encodes and decodes fragmented protocol v1 frames", () => {
  const frame = encodeSatelliteFrame({
    kind: SatelliteMessageKind.audioInput,
    payload: Uint8Array.of(1, 2, 3, 4),
  });
  assert.deepEqual([...frame.subarray(0, 12)], [
    0x53, 0x4f, 0x4c, 0x31, 1, 6, 0, 0, 0, 0, 0, 4,
  ]);

  const decoder = new SatelliteFrameDecoder();
  assert.deepEqual(decoder.push(frame.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(frame.subarray(3, 11)), []);
  assert.deepEqual(decoder.push(frame.subarray(11)), [
    {
      kind: SatelliteMessageKind.audioInput,
      payload: Uint8Array.of(1, 2, 3, 4),
    },
  ]);
  decoder.finish();
});

test("decodes multiple frames from one transport chunk", () => {
  const hello = encodeSatelliteFrame({
    kind: SatelliteMessageKind.hello,
    payload: new Uint8Array(),
  });
  const permission = encodeSatelliteFrame({
    kind: SatelliteMessageKind.permissionState,
    payload: Uint8Array.of(1),
  });
  const chunk = new Uint8Array(hello.byteLength + permission.byteLength);
  chunk.set(hello);
  chunk.set(permission, hello.byteLength);

  assert.deepEqual(new SatelliteFrameDecoder().push(chunk), [
    { kind: SatelliteMessageKind.hello, payload: new Uint8Array() },
    {
      kind: SatelliteMessageKind.permissionState,
      payload: Uint8Array.of(1),
    },
  ]);
});

test("rejects invalid headers, limits, payload shapes, and directions", () => {
  const hello = encodeSatelliteFrame({
    kind: SatelliteMessageKind.hello,
    payload: new Uint8Array(),
  });
  const cases: Array<[number, number, SatelliteProtocolError["code"]]> = [
    [0, 0, "invalid_magic"],
    [4, 2, "unsupported_version"],
    [5, 0xff, "unknown_kind"],
    [7, 1, "nonzero_flags"],
  ];
  for (const [offset, value, code] of cases) {
    const invalid = hello.slice();
    invalid[offset] = value;
    assert.throws(
      () => new SatelliteFrameDecoder().push(invalid),
      (error: unknown) =>
        error instanceof SatelliteProtocolError && error.code === code,
    );
  }

  assert.throws(
    () =>
      encodeSatelliteFrame({
        kind: SatelliteMessageKind.audioInput,
        payload: new Uint8Array(MAX_SATELLITE_AUDIO_BYTES + 2),
      }),
    (error: unknown) =>
      error instanceof SatelliteProtocolError &&
      error.code === "payload_too_large",
  );
  assert.throws(
    () =>
      encodeSatelliteFrame({
        kind: SatelliteMessageKind.playAudio,
        payload: Uint8Array.of(1, 2, 3),
      }),
    (error: unknown) =>
      error instanceof SatelliteProtocolError &&
      error.code === "invalid_payload",
  );
  assert.throws(
    () =>
      assertGatewayFrame({
        kind: SatelliteMessageKind.audioInput,
        payload: Uint8Array.of(1, 2),
      }),
    SatelliteProtocolError,
  );
  assert.throws(
    () =>
      assertSatelliteFrame({
        kind: SatelliteMessageKind.startCapture,
        payload: encodeCaptureDuration(15_000),
      }),
    SatelliteProtocolError,
  );
});

test("validates capture duration and incomplete transport shutdown", () => {
  assert.deepEqual([...encodeCaptureDuration(30_000)], [0, 0, 0x75, 0x30]);
  for (const duration of [0, 30_001, 1.5, Number.NaN]) {
    assert.throws(() => encodeCaptureDuration(duration), SatelliteProtocolError);
  }

  const decoder = new SatelliteFrameDecoder();
  decoder.push(Uint8Array.of(0x53, 0x4f));
  assert.throws(() => decoder.finish(), SatelliteProtocolError);
});

test("protocol errors never serialize a rejected payload", () => {
  const secret = new TextEncoder().encode("SECRET_TRANSCRIPT_VALUE");
  assert.throws(
    () =>
      encodeSatelliteFrame({
        kind: SatelliteMessageKind.hello,
        payload: secret,
      }),
    (error: unknown) =>
      error instanceof SatelliteProtocolError &&
      !error.message.includes("SECRET_TRANSCRIPT_VALUE"),
  );
});
