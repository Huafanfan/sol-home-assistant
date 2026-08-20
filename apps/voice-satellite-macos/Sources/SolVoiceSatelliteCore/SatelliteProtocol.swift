import Foundation

public enum SatelliteProtocolVersion: UInt8, CaseIterable, Sendable {
    case v1 = 1
    case localActivationV2 = 2
}

public enum SatelliteProtocolV1 {
    public static let version = SatelliteProtocolVersion.v1.rawValue
    public static let headerBytes = 12
    public static let maximumAudioBytes = 65_536
    public static let maximumControlBytes = 16
    static let magic = Data([0x53, 0x4f, 0x4c, 0x31])
}

public enum SatelliteProtocolV2 {
    public static let version = SatelliteProtocolVersion.localActivationV2.rawValue
}

public struct SatelliteActivationCapabilities: OptionSet, Equatable, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let localActivation = SatelliteActivationCapabilities(rawValue: 0x01)
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
    case startLocalListening = 0x20
    case localListeningStarted = 0x21
    case wakeDetected = 0x22
    case speechStarted = 0x23
    case speechEnded = 0x24
    case stopLocalListening = 0x25
    case localListeningStopped = 0x26
    case wakeTimedOut = 0x27
}

public struct SatelliteFrame: Equatable, Sendable {
    public let version: SatelliteProtocolVersion
    public let kind: SatelliteMessageKind
    public let payload: Data

    public init(
        version: SatelliteProtocolVersion = .v1,
        kind: SatelliteMessageKind,
        payload: Data = Data()
    ) {
        self.version = version
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
        encoded.append(frame.version.rawValue)
        encoded.append(frame.kind.rawValue)
        encoded.appendUInt16BE(0)
        encoded.appendUInt32BE(UInt32(frame.payload.count))
        encoded.append(frame.payload)
        return encoded
    }

    public static func validateGatewayFrame(_ frame: SatelliteFrame) throws {
        guard gatewayKinds(for: frame.version).contains(frame.kind) else {
            throw SatelliteProtocolFailure.invalidDirection
        }
        try validate(frame)
    }

    public static func validateSatelliteFrame(_ frame: SatelliteFrame) throws {
        guard satelliteKinds(for: frame.version).contains(frame.kind) else {
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

    public static func activationCapabilitiesPayload(
        _ capabilities: SatelliteActivationCapabilities
    ) throws -> Data {
        try validateActivationCapabilities(capabilities)
        return Data([capabilities.rawValue])
    }

    public static func activationCapabilities(
        from payload: Data
    ) throws -> SatelliteActivationCapabilities {
        guard payload.count == 1 else {
            throw SatelliteProtocolFailure.invalidPayload
        }
        let capabilities = SatelliteActivationCapabilities(rawValue: payload[0])
        try validateActivationCapabilities(capabilities)
        return capabilities
    }

    static func validate(_ frame: SatelliteFrame) throws {
        let length = frame.payload.count
        let limit = maximumPayloadBytes(for: frame.version, kind: frame.kind)
        guard length <= limit else {
            throw SatelliteProtocolFailure.payloadTooLarge
        }

        switch frame.version {
        case .v1:
            try validateV1Payload(kind: frame.kind, payload: frame.payload)
        case .localActivationV2:
            try validateV2Payload(kind: frame.kind, payload: frame.payload)
        }
    }

    static func maximumPayloadBytes(
        for version: SatelliteProtocolVersion,
        kind: SatelliteMessageKind
    ) -> Int {
        isAudio(version: version, kind: kind)
            ? SatelliteProtocolV1.maximumAudioBytes
            : SatelliteProtocolV1.maximumControlBytes
    }

    private static func validateV1Payload(
        kind: SatelliteMessageKind,
        payload: Data
    ) throws {
        let length = payload.count
        switch kind {
        case .hello, .requestPermission, .captureStarted, .stopCapture,
             .playbackStarted, .cancel, .cancelled, .deviceChanged,
             .shutdown, .shutdownComplete:
            try requireLength(length, 0)
        case .permissionState:
            guard length == 1, (payload.first ?? 0xff) <= 3 else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .startCapture:
            _ = try captureDuration(from: payload)
        case .audioInput, .playAudio:
            try validatePCM(payload)
        case .captureStopped:
            try validateStopReason(payload)
        case .playbackFinished:
            guard length == 1, (payload.first ?? 0xff) <= 3 else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .error:
            try requireLength(length, 2)
        default:
            throw SatelliteProtocolFailure.invalidPayload
        }
    }

    private static func validateV2Payload(
        kind: SatelliteMessageKind,
        payload: Data
    ) throws {
        let length = payload.count
        switch kind {
        case .hello:
            _ = try activationCapabilities(from: payload)
        case .requestPermission, .startLocalListening, .localListeningStarted,
             .wakeDetected, .speechStarted, .speechEnded, .stopLocalListening,
             .wakeTimedOut, .cancel, .cancelled, .deviceChanged, .shutdown,
             .shutdownComplete:
            try requireLength(length, 0)
        case .permissionState:
            guard length == 1, (payload.first ?? 0xff) <= 3 else {
                throw SatelliteProtocolFailure.invalidPayload
            }
        case .audioInput:
            try validatePCM(payload)
        case .localListeningStopped:
            try validateStopReason(payload)
        case .error:
            try requireLength(length, 2)
        default:
            throw SatelliteProtocolFailure.invalidPayload
        }
    }

    private static func gatewayKinds(
        for version: SatelliteProtocolVersion
    ) -> Set<SatelliteMessageKind> {
        switch version {
        case .v1:
            return [.requestPermission, .startCapture, .stopCapture, .playAudio,
                    .cancel, .shutdown]
        case .localActivationV2:
            return [.requestPermission, .startLocalListening, .stopLocalListening,
                    .cancel, .shutdown]
        }
    }

    private static func satelliteKinds(
        for version: SatelliteProtocolVersion
    ) -> Set<SatelliteMessageKind> {
        switch version {
        case .v1:
            return [.hello, .permissionState, .captureStarted, .audioInput,
                    .captureStopped, .playbackStarted, .playbackFinished,
                    .cancelled, .deviceChanged, .error, .shutdownComplete]
        case .localActivationV2:
            return [.hello, .permissionState, .localListeningStarted,
                    .wakeDetected, .speechStarted, .audioInput, .speechEnded,
                    .localListeningStopped, .wakeTimedOut, .cancelled,
                    .deviceChanged, .error, .shutdownComplete]
        }
    }

    private static func isAudio(
        version: SatelliteProtocolVersion,
        kind: SatelliteMessageKind
    ) -> Bool {
        kind == .audioInput || (version == .v1 && kind == .playAudio)
    }

    private static func validatePCM(_ payload: Data) throws {
        guard payload.count >= 2, payload.count.isMultiple(of: 2) else {
            throw SatelliteProtocolFailure.invalidPayload
        }
    }

    private static func validateStopReason(_ payload: Data) throws {
        guard payload.count == 1, (payload.first ?? 0xff) <= 4 else {
            throw SatelliteProtocolFailure.invalidPayload
        }
    }

    private static func validateActivationCapabilities(
        _ capabilities: SatelliteActivationCapabilities
    ) throws {
        let raw = capabilities.rawValue
        let known = SatelliteActivationCapabilities.localActivation.rawValue
        let unknownBits = raw & ~known
        guard raw != 0, unknownBits == 0 else {
            throw SatelliteProtocolFailure.invalidPayload
        }
    }

    private static func requireLength(_ actual: Int, _ expected: Int) throws {
        guard actual == expected else {
            throw SatelliteProtocolFailure.invalidPayload
        }
    }
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
            guard let version = SatelliteProtocolVersion(rawValue: buffered[4]) else {
                throw SatelliteProtocolFailure.unsupportedVersion
            }
            guard let kind = SatelliteMessageKind(rawValue: buffered[5]) else {
                throw SatelliteProtocolFailure.unknownKind
            }
            guard buffered.readUInt16BE(at: 6) == 0 else {
                throw SatelliteProtocolFailure.nonzeroFlags
            }
            let length = Int(buffered.readUInt32BE(at: 8))
            let limit = SatelliteFrameCodec.maximumPayloadBytes(
                for: version,
                kind: kind
            )
            guard length <= limit else {
                throw SatelliteProtocolFailure.payloadTooLarge
            }
            let frameBytes = SatelliteProtocolV1.headerBytes + length
            guard buffered.count >= frameBytes else { break }

            let payload = Data(buffered[SatelliteProtocolV1.headerBytes..<frameBytes])
            let frame = SatelliteFrame(version: version, kind: kind, payload: payload)
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
