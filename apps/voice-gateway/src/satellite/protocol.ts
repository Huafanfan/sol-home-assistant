const HEADER_BYTES = 12;
const MAGIC = Uint8Array.of(0x53, 0x4f, 0x4c, 0x31); // SOL1

export const SATELLITE_PROTOCOL_VERSION = 1;
export const MAX_SATELLITE_AUDIO_BYTES = 65_536;
export const MAX_SATELLITE_CONTROL_BYTES = 16;

export const SatelliteMessageKind = {
  hello: 0x01,
  requestPermission: 0x02,
  permissionState: 0x03,
  startCapture: 0x04,
  captureStarted: 0x05,
  audioInput: 0x06,
  stopCapture: 0x07,
  captureStopped: 0x08,
  playAudio: 0x09,
  playbackStarted: 0x0a,
  playbackFinished: 0x0b,
  cancel: 0x0c,
  cancelled: 0x0d,
  deviceChanged: 0x0e,
  error: 0x0f,
  shutdown: 0x10,
  shutdownComplete: 0x11,
} as const;

export type SatelliteMessageKind =
  (typeof SatelliteMessageKind)[keyof typeof SatelliteMessageKind];

export type SatelliteProtocolErrorCode =
  | "invalid_magic"
  | "unsupported_version"
  | "nonzero_flags"
  | "unknown_kind"
  | "payload_too_large"
  | "invalid_payload"
  | "invalid_direction";

const safeProtocolMessages: Readonly<
  Record<SatelliteProtocolErrorCode, string>
> = {
  invalid_magic: "Satellite protocol magic is invalid",
  unsupported_version: "Satellite protocol version is unsupported",
  nonzero_flags: "Satellite protocol flags are unsupported",
  unknown_kind: "Satellite protocol message kind is unknown",
  payload_too_large: "Satellite protocol payload exceeds its limit",
  invalid_payload: "Satellite protocol payload shape is invalid",
  invalid_direction: "Satellite protocol message direction is invalid",
};

export class SatelliteProtocolError extends Error {
  public constructor(public readonly code: SatelliteProtocolErrorCode) {
    super(safeProtocolMessages[code]);
    this.name = "SatelliteProtocolError";
  }
}

export interface SatelliteFrame {
  readonly kind: SatelliteMessageKind;
  readonly payload: Uint8Array;
}

const knownKinds = new Set<number>(Object.values(SatelliteMessageKind));
const gatewayKinds = new Set<SatelliteMessageKind>([
  SatelliteMessageKind.requestPermission,
  SatelliteMessageKind.startCapture,
  SatelliteMessageKind.stopCapture,
  SatelliteMessageKind.playAudio,
  SatelliteMessageKind.cancel,
  SatelliteMessageKind.shutdown,
]);
const satelliteKinds = new Set<SatelliteMessageKind>([
  SatelliteMessageKind.hello,
  SatelliteMessageKind.permissionState,
  SatelliteMessageKind.captureStarted,
  SatelliteMessageKind.audioInput,
  SatelliteMessageKind.captureStopped,
  SatelliteMessageKind.playbackStarted,
  SatelliteMessageKind.playbackFinished,
  SatelliteMessageKind.cancelled,
  SatelliteMessageKind.deviceChanged,
  SatelliteMessageKind.error,
  SatelliteMessageKind.shutdownComplete,
]);

export function assertGatewayFrame(frame: SatelliteFrame): void {
  if (!gatewayKinds.has(frame.kind)) {
    throw new SatelliteProtocolError("invalid_direction");
  }
  validatePayload(frame.kind, frame.payload);
}

export function assertSatelliteFrame(frame: SatelliteFrame): void {
  if (!satelliteKinds.has(frame.kind)) {
    throw new SatelliteProtocolError("invalid_direction");
  }
  validatePayload(frame.kind, frame.payload);
}

export function encodeSatelliteFrame(frame: SatelliteFrame): Uint8Array {
  validatePayload(frame.kind, frame.payload);
  const encoded = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  encoded.set(MAGIC, 0);
  encoded[4] = SATELLITE_PROTOCOL_VERSION;
  encoded[5] = frame.kind;
  writeUint16(encoded, 6, 0);
  writeUint32(encoded, 8, frame.payload.byteLength);
  encoded.set(frame.payload, HEADER_BYTES);
  return encoded;
}

export class SatelliteFrameDecoder {
  #buffer = new Uint8Array(0);

  public push(chunk: Uint8Array): readonly SatelliteFrame[] {
    if (chunk.byteLength === 0) {
      return [];
    }

    const next = new Uint8Array(this.#buffer.byteLength + chunk.byteLength);
    next.set(this.#buffer, 0);
    next.set(chunk, this.#buffer.byteLength);
    this.#buffer = next;

    const frames: SatelliteFrame[] = [];
    let offset = 0;
    while (this.#buffer.byteLength - offset >= HEADER_BYTES) {
      const view = this.#buffer.subarray(offset);
      validateHeader(view);
      const kind = view[5] as SatelliteMessageKind;
      const payloadLength = readUint32(view, 8);
      validateDeclaredLength(kind, payloadLength);
      const frameLength = HEADER_BYTES + payloadLength;
      if (view.byteLength < frameLength) {
        break;
      }

      const payload = view.slice(HEADER_BYTES, frameLength);
      validatePayload(kind, payload);
      frames.push({ kind, payload });
      offset += frameLength;
    }

    this.#buffer = this.#buffer.slice(offset);
    if (this.#buffer.byteLength > HEADER_BYTES + MAX_SATELLITE_AUDIO_BYTES) {
      throw new SatelliteProtocolError("payload_too_large");
    }
    return frames;
  }

  public finish(): void {
    if (this.#buffer.byteLength !== 0) {
      throw new SatelliteProtocolError("invalid_payload");
    }
  }
}

export function encodeCaptureDuration(durationMs: number): Uint8Array {
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 30_000) {
    throw new SatelliteProtocolError("invalid_payload");
  }
  const payload = new Uint8Array(4);
  writeUint32(payload, 0, durationMs);
  return payload;
}

export function decodeCaptureDuration(payload: Uint8Array): number {
  if (payload.byteLength !== 4) {
    throw new SatelliteProtocolError("invalid_payload");
  }
  const durationMs = readUint32(payload, 0);
  if (durationMs < 1 || durationMs > 30_000) {
    throw new SatelliteProtocolError("invalid_payload");
  }
  return durationMs;
}

function validateHeader(bytes: Uint8Array): void {
  if (
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new SatelliteProtocolError("invalid_magic");
  }
  if (bytes[4] !== SATELLITE_PROTOCOL_VERSION) {
    throw new SatelliteProtocolError("unsupported_version");
  }
  const rawKind = bytes[5];
  if (rawKind === undefined || !knownKinds.has(rawKind)) {
    throw new SatelliteProtocolError("unknown_kind");
  }
  if (readUint16(bytes, 6) !== 0) {
    throw new SatelliteProtocolError("nonzero_flags");
  }
}

function validateDeclaredLength(
  kind: SatelliteMessageKind,
  payloadLength: number,
): void {
  const limit = isAudioKind(kind)
    ? MAX_SATELLITE_AUDIO_BYTES
    : MAX_SATELLITE_CONTROL_BYTES;
  if (payloadLength > limit) {
    throw new SatelliteProtocolError("payload_too_large");
  }
}

function validatePayload(
  kind: SatelliteMessageKind,
  payload: Uint8Array,
): void {
  validateDeclaredLength(kind, payload.byteLength);
  const length = payload.byteLength;
  switch (kind) {
    case SatelliteMessageKind.hello:
    case SatelliteMessageKind.requestPermission:
    case SatelliteMessageKind.captureStarted:
    case SatelliteMessageKind.stopCapture:
    case SatelliteMessageKind.playbackStarted:
    case SatelliteMessageKind.cancel:
    case SatelliteMessageKind.cancelled:
    case SatelliteMessageKind.deviceChanged:
    case SatelliteMessageKind.shutdown:
    case SatelliteMessageKind.shutdownComplete:
      requireLength(length, 0);
      return;
    case SatelliteMessageKind.permissionState:
      requireLength(length, 1);
      if ((payload[0] ?? 0xff) > 3) {
        throw new SatelliteProtocolError("invalid_payload");
      }
      return;
    case SatelliteMessageKind.startCapture:
      decodeCaptureDuration(payload);
      return;
    case SatelliteMessageKind.audioInput:
    case SatelliteMessageKind.playAudio:
      if (length < 2 || length % 2 !== 0) {
        throw new SatelliteProtocolError("invalid_payload");
      }
      return;
    case SatelliteMessageKind.captureStopped:
      requireLength(length, 1);
      if ((payload[0] ?? 0xff) > 4) {
        throw new SatelliteProtocolError("invalid_payload");
      }
      return;
    case SatelliteMessageKind.playbackFinished:
      requireLength(length, 1);
      if ((payload[0] ?? 0xff) > 3) {
        throw new SatelliteProtocolError("invalid_payload");
      }
      return;
    case SatelliteMessageKind.error:
      requireLength(length, 2);
      return;
  }
}

function isAudioKind(kind: SatelliteMessageKind): boolean {
  return (
    kind === SatelliteMessageKind.audioInput ||
    kind === SatelliteMessageKind.playAudio
  );
}

function requireLength(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new SatelliteProtocolError("invalid_payload");
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1_00_00_00 +
      (bytes[offset + 1] ?? 0) * 0x1_00_00 +
      (bytes[offset + 2] ?? 0) * 0x1_00 +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
