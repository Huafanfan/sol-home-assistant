import Foundation

public enum SatelliteProtocolV1 {
    public static let version: UInt8 = 1
    public static let headerBytes = 12
    public static let maximumAudioBytes = 65_536
    public static let maximumControlBytes = 16
    static let magic = Data([0x53, 0x4f, 0x4c, 0x31])
}

public enum SatelliteMessageKind: UInt8, CaseIterable, Sendable {
    case hello = 0x01
    case requestPermission = 0x02
    case permissionState = 0x03
    case startCapture = 0x04
    case captureStarted = 0x05
    case audioInput = 0x06
    case stopCapture = 0x07
    case captureStopped = 0x08
    case playAudio = 0x09
    case playbackStarted = 0x0a
    case playbackFinished = 0x0b
    case cancel = 0x0c
    case cancelled = 0x0d
    case deviceChanged = 0x0e
    case error = 0x0f
    case shutdown = 0x10
    case shutdownComplete = 0x11
}

public struct SatelliteFrame: Equatable, Sendable {
    public let kind: SatelliteMessageKind
    public let payload: Data

    public init(kind: SatelliteMessageKind, payload: Data = Data()) {
        self.kind = kind
        self.payload = payload
    }
}

public enum SatelliteProtocolFailure: Error, Equatable, Sendable {
    case invalidMagic
    case unsupportedVersion
    case nonzeroFlags
    case unknownKind
    case payloadTooLarge
    case invalidPayload
    case invalidDirection
    case incompleteFrame
}

public enum SatelliteFrameCodec {
    public static func encode(_ frame: SatelliteFrame) throws -> Data {
        try validate(frame)
        var encoded = Data()
        encoded.reserveCapacity(SatelliteProtocolV1.headerBytes + frame.payload.count)
        encoded.append(SatelliteProtocolV1.magic)
        encoded.append(SatelliteProtocolV1.version)
        encoded.append(frame.kind.rawValue)
        encoded.appendUInt16BE(0)
        encoded.appendUInt32BE(UInt32(frame.payload.count))
        encoded.append(frame.payload)
        return encoded
    }

    public static func validateGatewayFrame(_ frame: SatelliteFrame) throws {
        guard gatewayKinds.contains(frame.kind) else {
            throw SatelliteProtocolFailure.invalidDirection
        }
        try validate(frame)
    }

    public static func validateSatelliteFrame(_ frame: SatelliteFrame) throws {
        guard satelliteKinds.contains(frame.kind) else {
            throw SatelliteProtocolFailure.invalidDirection
        }
        try validate(frame)
    }

    public static func captureDuration(from payload: Data) throws -> Int {
        guard payload.count == 4 else {
            throw SatelliteProtocolFailure.invalidPayload
        }
        let duration = Int(payload.readUInt32BE(at: 0))
        guard (1...30_000).contains(duration) else {
            throw SatelliteProtocolFailure.invalidPayload
        }
        return duration
    }

    public static func captureDurationPayload(milliseconds: Int) throws -> Data {
        guard (1...30_000).contains(milliseconds) else {
            throw SatelliteProtocolFailure.invalidPayload
        }
        var payload = Data()
        payload.appendUInt32BE(UInt32(milliseconds))
        return payload
    }

    static func validate(_ frame: SatelliteFrame) throws {
        let length = frame.payload.count
        let limit = isAudio(frame.kind)
            ? SatelliteProtocolV1.maximumAudioBytes
            : SatelliteProtocolV1.maximumControlBytes
        guard length <= limit else {
            throw SatelliteProtocolFailure.payloadTooLarge
        }

        switch frame.kind {
        case .hello, .requestPermission, .captureStarted, .stopCapture,
             .playbackStarted, .cancel, .cancelled, .deviceChanged,
             .shutdown, .shutdownComplete:
            guard length == 0 else { throw SatelliteProtocolFailure.invalidPayload }
        case .permissionState:
            guard length == 1, (frame.payload.first ?? 0xff) <= 3 else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .startCapture:
            _ = try captureDuration(from: frame.payload)
        case .audioInput, .playAudio:
            guard length >= 2, length.isMultiple(of: 2) else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .captureStopped:
            guard length == 1, (frame.payload.first ?? 0xff) <= 4 else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .playbackFinished:
            guard length == 1, (frame.payload.first ?? 0xff) <= 3 else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .error:
            guard length == 2 else { throw SatelliteProtocolFailure.invalidPayload }
        }
    }

    private static func isAudio(_ kind: SatelliteMessageKind) -> Bool {
        kind == .audioInput || kind == .playAudio
    }

    private static let gatewayKinds: Set<SatelliteMessageKind> = [
        .requestPermission, .startCapture, .stopCapture, .playAudio,
        .cancel, .shutdown,
    ]
    private static let satelliteKinds: Set<SatelliteMessageKind> = [
        .hello, .permissionState, .captureStarted, .audioInput,
        .captureStopped, .playbackStarted, .playbackFinished,
        .cancelled, .deviceChanged, .error, .shutdownComplete,
    ]
}

public struct SatelliteFrameDecoder: Sendable {
    private var buffered = Data()

    public init() {}

    public mutating func append(_ chunk: Data) throws -> [SatelliteFrame] {
        guard !chunk.isEmpty else { return [] }
        buffered.append(chunk)
        var frames: [SatelliteFrame] = []

        while buffered.count >= SatelliteProtocolV1.headerBytes {
            guard buffered.prefix(4) == SatelliteProtocolV1.magic else {
                throw SatelliteProtocolFailure.invalidMagic
            }
            guard buffered[4] == SatelliteProtocolV1.version else {
                throw SatelliteProtocolFailure.unsupportedVersion
            }
            guard let kind = SatelliteMessageKind(rawValue: buffered[5]) else {
                throw SatelliteProtocolFailure.unknownKind
            }
            guard buffered.readUInt16BE(at: 6) == 0 else {
                throw SatelliteProtocolFailure.nonzeroFlags
            }
            let length = Int(buffered.readUInt32BE(at: 8))
            let limit = (kind == .audioInput || kind == .playAudio)
                ? SatelliteProtocolV1.maximumAudioBytes
                : SatelliteProtocolV1.maximumControlBytes
            guard length <= limit else {
                throw SatelliteProtocolFailure.payloadTooLarge
            }
            let frameBytes = SatelliteProtocolV1.headerBytes + length
            guard buffered.count >= frameBytes else { break }

            let payload = Data(buffered[SatelliteProtocolV1.headerBytes..<frameBytes])
            let frame = SatelliteFrame(kind: kind, payload: payload)
            try SatelliteFrameCodec.validate(frame)
            frames.append(frame)
            buffered = Data(buffered.dropFirst(frameBytes))
        }

        guard buffered.count <= SatelliteProtocolV1.headerBytes + SatelliteProtocolV1.maximumAudioBytes else {
            throw SatelliteProtocolFailure.payloadTooLarge
        }
        return frames
    }

    public func finish() throws {
        guard buffered.isEmpty else {
            throw SatelliteProtocolFailure.incompleteFrame
        }
    }
}

extension Data {
    mutating func appendUInt16BE(_ value: UInt16) {
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    mutating func appendUInt32BE(_ value: UInt32) {
        append(UInt8((value >> 24) & 0xff))
        append(UInt8((value >> 16) & 0xff))
        append(UInt8((value >> 8) & 0xff))
        append(UInt8(value & 0xff))
    }

    func readUInt16BE(at offset: Int) -> UInt16 {
        (UInt16(self[offset]) << 8) | UInt16(self[offset + 1])
    }

    func readUInt32BE(at offset: Int) -> UInt32 {
        (UInt32(self[offset]) << 24)
            | (UInt32(self[offset + 1]) << 16)
            | (UInt32(self[offset + 2]) << 8)
            | UInt32(self[offset + 3])
    }
}
