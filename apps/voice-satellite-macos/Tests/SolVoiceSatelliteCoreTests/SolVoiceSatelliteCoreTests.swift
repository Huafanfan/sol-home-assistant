import AVFoundation
import Foundation
import XCTest
@testable import SolVoiceSatelliteCore

final class SatelliteProtocolTests: XCTestCase {
    func testFragmentedAndConcatenatedFramesRoundTrip() throws {
        let hello = try SatelliteFrameCodec.encode(SatelliteFrame(kind: .hello))
        let audio = try SatelliteFrameCodec.encode(
            SatelliteFrame(kind: .audioInput, payload: Data([1, 2, 3, 4]))
        )
        var decoder = SatelliteFrameDecoder()

        XCTAssertEqual(try decoder.append(hello.prefix(3)), [])
        XCTAssertEqual(try decoder.append(hello.dropFirst(3) + audio.prefix(5)), [
            SatelliteFrame(kind: .hello),
        ])
        XCTAssertEqual(try decoder.append(audio.dropFirst(5)), [
            SatelliteFrame(kind: .audioInput, payload: Data([1, 2, 3, 4])),
        ])
        XCTAssertNoThrow(try decoder.finish())
    }

    func testRejectsInvalidHeadersPayloadsLimitsAndDirections() throws {
        let hello = try SatelliteFrameCodec.encode(SatelliteFrame(kind: .hello))
        let mutations: [(Int, UInt8, SatelliteProtocolFailure)] = [
            (0, 0, .invalidMagic),
            (4, 2, .unsupportedVersion),
            (5, 0xff, .unknownKind),
            (7, 1, .nonzeroFlags),
        ]
        for (offset, value, expected) in mutations {
            var invalid = hello
            invalid[offset] = value
            var decoder = SatelliteFrameDecoder()
            XCTAssertThrowsError(try decoder.append(invalid)) { error in
                XCTAssertEqual(error as? SatelliteProtocolFailure, expected)
            }
        }

        XCTAssertThrowsError(
            try SatelliteFrameCodec.encode(
                SatelliteFrame(
                    kind: .audioInput,
                    payload: Data(count: SatelliteProtocolV1.maximumAudioBytes + 2)
                )
            )
        )
        XCTAssertThrowsError(
            try SatelliteFrameCodec.encode(
                SatelliteFrame(kind: .playAudio, payload: Data([1, 2, 3]))
            )
        )
        XCTAssertThrowsError(
            try SatelliteFrameCodec.validateGatewayFrame(
                SatelliteFrame(kind: .audioInput, payload: Data([1, 2]))
            )
        )
        XCTAssertThrowsError(
            try SatelliteFrameCodec.validateSatelliteFrame(
                SatelliteFrame(
                    kind: .startCapture,
                    payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 15_000)
                )
            )
        )
    }

    func testCaptureDurationHasHardLimit() throws {
        XCTAssertEqual(
            try SatelliteFrameCodec.captureDuration(
                from: SatelliteFrameCodec.captureDurationPayload(milliseconds: 30_000)
            ),
            30_000
        )
        XCTAssertThrowsError(
            try SatelliteFrameCodec.captureDurationPayload(milliseconds: 0)
        )
        XCTAssertThrowsError(
            try SatelliteFrameCodec.captureDurationPayload(milliseconds: 30_001)
        )
    }
}

final class SatelliteRuntimeTests: XCTestCase {
    func testDeniedAndRestrictedPermissionNeverStartCapture() async throws {
        for permission in [
            MicrophonePermissionState.notDetermined, .denied, .restricted,
        ] {
            let audio = FakeAudioDevice()
            let writer = RecordingFrameWriter()
            let runtime = SatelliteRuntime(
                permissionAuthorizer: FixedPermissionAuthorizer(permission),
                audioDevice: audio,
                writer: writer
            )
            try runtime.start()
            try await runtime.handle(SatelliteFrame(kind: .requestPermission))
            try await runtime.handle(
                SatelliteFrame(
                    kind: .startCapture,
                    payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 15_000)
                )
            )

            XCTAssertEqual(audio.captureStarts, 0)
            XCTAssertEqual(runtime.state, .permissionBlocked)
            XCTAssertEqual(writer.frames.map(\.kind), [.hello, .permissionState, .error])
            XCTAssertEqual(writer.frames[1].payload, Data([permission.rawValue]))
        }
    }

    func testCaptureForwardsBoundedPCMAndReleasesOnStop() async throws {
        let audio = FakeAudioDevice()
        let writer = RecordingFrameWriter()
        let runtime = authorizedRuntime(audio: audio, writer: writer)
        try runtime.start()
        try await runtime.handle(SatelliteFrame(kind: .requestPermission))
        try await runtime.handle(
            SatelliteFrame(
                kind: .startCapture,
                payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 15_000)
            )
        )
        audio.emitInput(Data([1, 2, 3, 4]))
        audio.emitInput(Data([1]))
        try await runtime.handle(SatelliteFrame(kind: .stopCapture))

        XCTAssertEqual(audio.captureStarts, 1)
        XCTAssertEqual(audio.lastDuration, 15_000)
        XCTAssertFalse(audio.captureActive)
        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(writer.frames.map(\.kind), [
            .hello, .permissionState, .captureStarted, .audioInput, .captureStopped,
        ])
        XCTAssertEqual(writer.frames[3].payload.count, 4)
    }

    func testCancelStopsCaptureAndPlaybackBeforeCancelled() async throws {
        let audio = FakeAudioDevice()
        let writer = RecordingFrameWriter()
        let runtime = authorizedRuntime(audio: audio, writer: writer)
        try runtime.start()
        try await runtime.handle(SatelliteFrame(kind: .requestPermission))
        try await runtime.handle(
            SatelliteFrame(
                kind: .startCapture,
                payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 1_000)
            )
        )
        try await runtime.handle(SatelliteFrame(kind: .cancel))

        XCTAssertFalse(audio.captureActive)
        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(Array(writer.frames.suffix(2).map(\.kind)), [
            .captureStopped, .cancelled,
        ])

        try await runtime.handle(
            SatelliteFrame(kind: .playAudio, payload: Data([1, 2, 3, 4]))
        )
        try await runtime.handle(SatelliteFrame(kind: .cancel))
        XCTAssertFalse(audio.playbackActive)
        XCTAssertEqual(Array(writer.frames.suffix(3).map(\.kind)), [
            .playbackStarted, .playbackFinished, .cancelled,
        ])
    }

    func testDeviceChangeSafelyTerminatesCurrentCapture() async throws {
        let audio = FakeAudioDevice()
        let writer = RecordingFrameWriter()
        let runtime = authorizedRuntime(audio: audio, writer: writer)
        try runtime.start()
        try await runtime.handle(SatelliteFrame(kind: .requestPermission))
        try await runtime.handle(
            SatelliteFrame(
                kind: .startCapture,
                payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 500)
            )
        )
        audio.emitDeviceChange()

        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(Array(writer.frames.suffix(2).map(\.kind)), [
            .deviceChanged, .captureStopped,
        ])
        XCTAssertEqual(writer.frames.last?.payload, Data([CaptureStopReason.deviceChanged.rawValue]))
    }

    func testCaptureLimitAndInjectedFailuresReleaseResources() async throws {
        let audio = FakeAudioDevice()
        let writer = RecordingFrameWriter()
        let runtime = authorizedRuntime(audio: audio, writer: writer)
        try runtime.start()
        try await runtime.handle(SatelliteFrame(kind: .requestPermission))
        try await runtime.handle(
            SatelliteFrame(
                kind: .startCapture,
                payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 30_000)
            )
        )
        audio.emitCaptureLimit()
        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(writer.frames.last?.payload, Data([CaptureStopReason.limit.rawValue]))

        audio.throwOnCapture = true
        try await runtime.handle(
            SatelliteFrame(
                kind: .startCapture,
                payload: SatelliteFrameCodec.captureDurationPayload(milliseconds: 1_000)
            )
        )
        XCTAssertFalse(audio.captureActive)
        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(Array(writer.frames.suffix(3).map(\.kind)), [
            .captureStarted, .captureStopped, .error,
        ])

        audio.throwOnCapture = false
        audio.throwOnPlayback = true
        try await runtime.handle(
            SatelliteFrame(kind: .playAudio, payload: Data([1, 2]))
        )
        XCTAssertFalse(audio.playbackActive)
        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(Array(writer.frames.suffix(3).map(\.kind)), [
            .playbackStarted, .playbackFinished, .error,
        ])
    }

    func testInjectedPlaybackUnderrunStopsAndReleasesPlayback() async throws {
        let audio = FakeAudioDevice()
        let writer = RecordingFrameWriter()
        let runtime = authorizedRuntime(audio: audio, writer: writer)
        try runtime.start()
        try await runtime.handle(SatelliteFrame(kind: .requestPermission))
        try await runtime.handle(
            SatelliteFrame(kind: .playAudio, payload: Data([1, 2, 3, 4]))
        )
        audio.emitPlaybackUnderrun()

        XCTAssertFalse(audio.playbackActive)
        XCTAssertEqual(runtime.state, .ready)
        XCTAssertEqual(Array(writer.frames.suffix(2).map(\.kind)), [
            .playbackStarted, .playbackFinished,
        ])
        XCTAssertEqual(
            writer.frames.last?.payload,
            Data([PlaybackStopReason.failure.rawValue])
        )
    }

    private func authorizedRuntime(
        audio: FakeAudioDevice,
        writer: RecordingFrameWriter
    ) -> SatelliteRuntime {
        SatelliteRuntime(
            permissionAuthorizer: FixedPermissionAuthorizer(.authorized),
            audioDevice: audio,
            writer: writer
        )
    }
}

final class PCM16ConverterTests: XCTestCase {
    func testConvertsStereo48kFloatToMono16kInt16() throws {
        let inputFormat = try XCTUnwrap(
            AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: 48_000,
                channels: 2,
                interleaved: false
            )
        )
        let buffer = try XCTUnwrap(
            AVAudioPCMBuffer(pcmFormat: inputFormat, frameCapacity: 480)
        )
        buffer.frameLength = 480
        let channels = try XCTUnwrap(buffer.floatChannelData)
        for channel in 0..<2 {
            for frame in 0..<480 {
                channels[channel][frame] = channel == 0 ? 0.25 : -0.25
            }
        }

        let converted = try PCM16Converter(inputFormat: inputFormat).convert(buffer)
        XCTAssertFalse(converted.isEmpty)
        XCTAssertTrue(converted.count.isMultiple(of: 2))
        XCTAssertLessThanOrEqual(converted.count, 384)
    }
}

private struct FixedPermissionAuthorizer: MicrophonePermissionAuthorizing {
    let permission: MicrophonePermissionState

    init(_ permission: MicrophonePermissionState) {
        self.permission = permission
    }

    func requestPermission() async -> MicrophonePermissionState { permission }
}

private final class RecordingFrameWriter: @unchecked Sendable, SatelliteFrameWriting {
    private let lock = NSLock()
    private var stored: [SatelliteFrame] = []

    var frames: [SatelliteFrame] {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func write(_ frame: SatelliteFrame) throws {
        _ = try SatelliteFrameCodec.encode(frame)
        lock.lock()
        stored.append(frame)
        lock.unlock()
    }
}

private final class FakeAudioDevice: @unchecked Sendable, SatelliteAudioDevice {
    var onInputFrame: (@Sendable (Data) -> Void)?
    var onCaptureStopped: (@Sendable (CaptureStopReason) -> Void)?
    var onPlaybackStopped: (@Sendable (PlaybackStopReason) -> Void)?
    var onDeviceChanged: (@Sendable () -> Void)?

    var captureStarts = 0
    var lastDuration: Int?
    var captureActive = false
    var playbackActive = false
    var throwOnCapture = false
    var throwOnPlayback = false

    func startCapture(maxDurationMilliseconds: Int) throws {
        captureStarts += 1
        lastDuration = maxDurationMilliseconds
        if throwOnCapture {
            throw SatelliteAudioFailure.deviceUnavailable
        }
        captureActive = true
    }

    func stopCapture(reason: CaptureStopReason) {
        guard captureActive else { return }
        captureActive = false
        onCaptureStopped?(reason)
    }

    func play(pcm: Data) throws {
        guard !pcm.isEmpty, pcm.count.isMultiple(of: 2) else {
            throw SatelliteAudioFailure.formatUnsupported
        }
        if throwOnPlayback {
            throw SatelliteAudioFailure.deviceUnavailable
        }
        playbackActive = true
    }

    func stopPlayback(reason: PlaybackStopReason) {
        guard playbackActive else { return }
        playbackActive = false
        onPlaybackStopped?(reason)
    }

    func cancel(completion: @escaping @Sendable () -> Void) {
        stopCapture(reason: .cancelled)
        stopPlayback(reason: .cancelled)
        completion()
    }

    func shutdown(completion: @escaping @Sendable () -> Void) {
        stopCapture(reason: .cancelled)
        stopPlayback(reason: .cancelled)
        completion()
    }

    func emitInput(_ data: Data) {
        onInputFrame?(data)
    }

    func emitDeviceChange() {
        onDeviceChanged?()
        if captureActive {
            stopCapture(reason: .deviceChanged)
        }
        if playbackActive {
            stopPlayback(reason: .deviceChanged)
        }
    }

    func emitCaptureLimit() {
        stopCapture(reason: .limit)
    }

    func emitPlaybackUnderrun() {
        stopPlayback(reason: .failure)
    }
}
