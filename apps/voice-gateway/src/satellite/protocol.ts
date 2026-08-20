const HEADER_BYTES = 12;
const MAGIC = Uint8Array.of(0x53, 0x4f, 0x4c, 0x31); // SOL1 protocol family

/**
 * The established manual-capture transport. Keep this export as the default
 * so every existing VOICE-004 caller continues to emit v1 frames.
 */
export const SATELLITE_PROTOCOL_VERSION = 1;

/**
 * Local activation uses an explicit protocol version rather than extending
 * v1's manual-capture messages with new meaning.
 */
export const SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION = 2;

export type SatelliteProtocolVersion =
  | typeof SATELLITE_PROTOCOL_VERSION
  | typeof SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION;

export const MAX_SATELLITE_AUDIO_BYTES = 65_536;
export const MAX_SATELLITE_CONTROL_BYTES = 16;

export const SatelliteActivationCapability = {
  localActivation: 0x01,
} as const;

const KNOWN_ACTIVATION_CAPABILITIES =
  SatelliteActivationCapability.localActivation;

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
  startLocalListening: 0x20,
  localListeningStarted: 0x21,
  wakeDetected: 0x22,
  speechStarted: 0x23,
  speechEnded: 0x24,
  stopLocalListening: 0x25,
  localListeningStopped: 0x26,
  wakeTimedOut: 0x27,
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

/**
 * Omitting version deliberately means the established v1 transport. Decoder
 * output preserves that omission for v1 so existing callers keep their frame
 * shapes; v2 frames always carry their explicit version.
 */
export interface SatelliteFrame {
  readonly version?: SatelliteProtocolVersion;
  readonly kind: SatelliteMessageKind;
  readonly payload: Uint8Array;
}

const knownKinds = new Set<number>(Object.values(SatelliteMessageKind));

const gatewayKindsV1 = new Set<SatelliteMessageKind>([
  SatelliteMessageKind.requestPermission,
  SatelliteMessageKind.startCapture,
  SatelliteMessageKind.stopCapture,
  SatelliteMessageKind.playAudio,
  SatelliteMessageKind.cancel,
  SatelliteMessageKind.shutdown,
]);

const satelliteKindsV1 = new Set<SatelliteMessageKind>([
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

const gatewayKindsV2 = new Set<SatelliteMessageKind>([
  SatelliteMessageKind.requestPermission,
  SatelliteMessageKind.startLocalListening,
  SatelliteMessageKind.stopLocalListening,
  SatelliteMessageKind.cancel,
  SatelliteMessageKind.shutdown,
]);

const satelliteKindsV2 = new Set<SatelliteMessageKind>([
  SatelliteMessageKind.hello,
  SatelliteMessageKind.permissionState,
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
  SatelliteMessageKind.shutdownComplete,
]);

export function assertGatewayFrame(frame: SatelliteFrame): void {
  const version = frameVersion(frame);
  if (!gatewayKindsFor(version).has(frame.kind)) {
    throw new SatelliteProtocolError("invalid_direction");
  }
  validatePayload(version, frame.kind, frame.payload);
}

export function assertSatelliteFrame(frame: SatelliteFrame): void {
  const version = frameVersion(frame);
  if (!satelliteKindsFor(version).has(frame.kind)) {
    throw new SatelliteProtocolError("invalid_direction");
  }
  validatePayload(version, frame.kind, frame.payload);
}

export function encodeSatelliteFrame(frame: SatelliteFrame): Uint8Array {
  const version = frameVersion(frame);
  validatePayload(version, frame.kind, frame.payload);
  const encoded = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  encoded.set(MAGIC, 0);
  encoded[4] = version;
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
      const version = validateHeader(view);
      const kind = view[5] as SatelliteMessageKind;
      const payloadLength = readUint32(view, 8);
      validateDeclaredLength(version, kind, payloadLength);
      const frameLength = HEADER_BYTES + payloadLength;
      if (view.byteLength < frameLength) {
        break;
      }

      const payload = view.slice(HEADER_BYTES, frameLength);
      validatePayload(version, kind, payload);
      frames.push(
        version === SATELLITE_PROTOCOL_VERSION
          ? { kind, payload }
          : { version, kind, payload },
      );
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

export function encodeActivationCapabilities(capabilities: number): Uint8Array {
  if (
    !Number.isInteger(capabilities) ||
    capabilities <= 0 ||
    capabilities > 0xff ||
    (capabilities & ~KNOWN_ACTIVATION_CAPABILITIES) !== 0
  ) {
    throw new SatelliteProtocolError("invalid_payload");
  }
  return Uint8Array.of(capabilities);
}

export function decodeActivationCapabilities(payload: Uint8Array): number {
  if (payload.byteLength !== 1) {
    throw new SatelliteProtocolError("invalid_payload");
  }
  const capabilities = payload[0] ?? 0;
  if (
    capabilities === 0 ||
    (capabilities & ~KNOWN_ACTIVATION_CAPABILITIES) !== 0
  ) {
    throw new SatelliteProtocolError("invalid_payload");
  }
  return capabilities;
}

function frameVersion(frame: SatelliteFrame): SatelliteProtocolVersion {
  const version = frame.version ?? SATELLITE_PROTOCOL_VERSION;
  if (
    version !== SATELLITE_PROTOCOL_VERSION &&
    version !== SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION
  ) {
    throw new SatelliteProtocolError("unsupported_version");
  }
  return version;
}

function validateHeader(bytes: Uint8Array): SatelliteProtocolVersion {
  if (
    bytes[0] !== MAGIC[0] ||
    bytes[1] !== MAGIC[1] ||
    bytes[2] !== MAGIC[2] ||
    bytes[3] !== MAGIC[3]
  ) {
    throw new SatelliteProtocolError("invalid_magic");
  }
  const version = bytes[4];
  if (
    version !== SATELLITE_PROTOCOL_VERSION &&
    version !== SATELLITE_LOCAL_ACTIVATION_PROTOCOL_VERSION
  ) {
    throw new SatelliteProtocolError("unsupported_version");
  }
  const rawKind = bytes[5];
  if (rawKind === undefined || !knownKinds.has(rawKind)) {
    throw new SatelliteProtocolError("unknown_kind");
  }
  if (readUint16(bytes, 6) !== 0) {
    throw new SatelliteProtocolError("nonzero_flags");
  }
  return version;
}

function validateDeclaredLength(
  version: SatelliteProtocolVersion,
  kind: SatelliteMessageKind,
  payloadLength: number,
): void {
  const limit = isAudioKind(version, kind)
    ? MAX_SATELLITE_AUDIO_BYTES
    : MAX_SATELLITE_CONTROL_BYTES;
  if (payloadLength > limit) {
    throw new SatelliteProtocolError("payload_too_large");
  }
}

function validatePayload(
  version: SatelliteProtocolVersion,
  kind: SatelliteMessageKind,
  payload: Uint8Array,
): void {
  validateDeclaredLength(version, kind, payload.byteLength);
  if (version === SATELLITE_PROTOCOL_VERSION) {
    validateV1Payload(kind, payload);
    return;
  }
  validateV2Payload(kind, payload);
}

function validateV1Payload(kind: SatelliteMessageKind, payload: Uint8Array): void {
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
      validatePcmPayload(payload);
      return;
    case SatelliteMessageKind.captureStopped:
      validateStopReason(payload);
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
    default:
      throw new SatelliteProtocolError("invalid_payload");
  }
}

function validateV2Payload(kind: SatelliteMessageKind, payload: Uint8Array): void {
  const length = payload.byteLength;
  switch (kind) {
    case SatelliteMessageKind.hello:
      decodeActivationCapabilities(payload);
      return;
    case SatelliteMessageKind.requestPermission:
    case SatelliteMessageKind.startLocalListening:
    case SatelliteMessageKind.localListeningStarted:
    case SatelliteMessageKind.wakeDetected:
    case SatelliteMessageKind.speechStarted:
    case SatelliteMessageKind.speechEnded:
    case SatelliteMessageKind.stopLocalListening:
    case SatelliteMessageKind.wakeTimedOut:
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
    case SatelliteMessageKind.audioInput:
      validatePcmPayload(payload);
      return;
    case SatelliteMessageKind.localListeningStopped:
      validateStopReason(payload);
      return;
    case SatelliteMessageKind.error:
      requireLength(length, 2);
      return;
    default:
      throw new SatelliteProtocolError("invalid_payload");
  }
}

function gatewayKindsFor(
  version: SatelliteProtocolVersion,
): ReadonlySet<SatelliteMessageKind> {
  return version === SATELLITE_PROTOCOL_VERSION
    ? gatewayKindsV1
    : gatewayKindsV2;
}

function satelliteKindsFor(
  version: SatelliteProtocolVersion,
): ReadonlySet<SatelliteMessageKind> {
  return version === SATELLITE_PROTOCOL_VERSION
    ? satelliteKindsV1
    : satelliteKindsV2;
}

function isAudioKind(
  version: SatelliteProtocolVersion,
  kind: SatelliteMessageKind,
): boolean {
  return (
    kind === SatelliteMessageKind.audioInput ||
    (version === SATELLITE_PROTOCOL_VERSION &&
      kind === SatelliteMessageKind.playAudio)
  );
}

function validatePcmPayload(payload: Uint8Array): void {
  if (payload.byteLength < 2 || payload.byteLength % 2 !== 0) {
    throw new SatelliteProtocolError("invalid_payload");
  }
}

function validateStopReason(payload: Uint8Array): void {
  requireLength(payload.byteLength, 1);
  if ((payload[0] ?? 0xff) > 4) {
    throw new SatelliteProtocolError("invalid_payload");
  }
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
