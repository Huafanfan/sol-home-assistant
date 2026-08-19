import Foundation

public enum MicrophonePermissionState: UInt8, Sendable {
    case notDetermined = 0
    case authorized = 1
    case denied = 2
    case restricted = 3
}

public enum CaptureStopReason: UInt8, Sendable {
    case requested = 0
    case limit = 1
    case deviceChanged = 2
    case failure = 3
    case cancelled = 4
}

public enum PlaybackStopReason: UInt8, Sendable {
    case completed = 0
    case deviceChanged = 1
    case failure = 2
    case cancelled = 3
}

public enum SatelliteSafeErrorCode: UInt16, Sendable {
    case invalidSequence = 1
    case protocolViolation = 2
    case permissionBlocked = 3
    case audioUnavailable = 4
    case audioFormatUnsupported = 5
}

public enum SatelliteRuntimeState: Sendable {
    case stopped
    case waitingPermission
    case permissionBlocked
    case ready
    case capturing
    case playing
    case cancelling
    case stopping
    case failed
}

public protocol MicrophonePermissionAuthorizing: Sendable {
    func requestPermission() async -> MicrophonePermissionState
}

public protocol SatelliteFrameWriting: Sendable {
    func write(_ frame: SatelliteFrame) throws
}

public protocol SatelliteAudioDevice: AnyObject {
    var onInputFrame: (@Sendable (Data) -> Void)? { get set }
    var onCaptureStopped: (@Sendable (CaptureStopReason) -> Void)? { get set }
    var onPlaybackStopped: (@Sendable (PlaybackStopReason) -> Void)? { get set }
    var onDeviceChanged: (@Sendable () -> Void)? { get set }

    func startCapture(maxDurationMilliseconds: Int) throws
    func stopCapture(reason: CaptureStopReason)
    func play(pcm: Data) throws
    func stopPlayback(reason: PlaybackStopReason)
    func cancel(completion: @escaping @Sendable () -> Void)
    func shutdown(completion: @escaping @Sendable () -> Void)
}

public final class SatelliteRuntime: @unchecked Sendable {
    private let permissionAuthorizer: MicrophonePermissionAuthorizing
    private let audioDevice: SatelliteAudioDevice
    private let writer: SatelliteFrameWriting
    private let lock = NSLock()
    private var currentState: SatelliteRuntimeState = .stopped
    private var permissionState: MicrophonePermissionState = .notDetermined

    public init(
        permissionAuthorizer: MicrophonePermissionAuthorizing,
        audioDevice: SatelliteAudioDevice,
        writer: SatelliteFrameWriting
    ) {
        self.permissionAuthorizer = permissionAuthorizer
        self.audioDevice = audioDevice
        self.writer = writer

        audioDevice.onInputFrame = { [weak self] data in
            self?.receivedInput(data)
        }
        audioDevice.onCaptureStopped = { [weak self] reason in
            self?.captureStopped(reason)
        }
        audioDevice.onPlaybackStopped = { [weak self] reason in
            self?.playbackStopped(reason)
        }
        audioDevice.onDeviceChanged = { [weak self] in
            self?.deviceChanged()
        }
    }

    public var state: SatelliteRuntimeState {
        lock.withLock { currentState }
    }

    public func start() throws {
        guard transition(from: [.stopped], to: .waitingPermission) else {
            try sendError(.invalidSequence)
            return
        }
        try writer.write(SatelliteFrame(kind: .hello))
    }

    public func handle(_ frame: SatelliteFrame) async throws {
        do {
            try SatelliteFrameCodec.validateGatewayFrame(frame)
        } catch {
            try sendError(.protocolViolation)
            throw error
        }

        switch frame.kind {
        case .requestPermission:
            await handlePermissionRequest()
        case .startCapture:
            try handleStartCapture(frame.payload)
        case .stopCapture:
            handleStopCapture()
        case .playAudio:
            try handlePlayback(frame.payload)
        case .cancel:
            await handleCancel()
        case .shutdown:
            await handleShutdown()
        default:
            try sendError(.invalidSequence)
        }
    }

    private func handlePermissionRequest() async {
        guard state == .waitingPermission || state == .permissionBlocked else {
            try? sendError(.invalidSequence)
            return
        }
        let resolved = await permissionAuthorizer.requestPermission()
        lock.withLock {
            permissionState = resolved
            currentState = resolved == .authorized ? .ready : .permissionBlocked
        }
        try? writer.write(
            SatelliteFrame(kind: .permissionState, payload: Data([resolved.rawValue]))
        )
    }

    private func handleStartCapture(_ payload: Data) throws {
        guard permissionState == .authorized, state == .ready else {
            try sendError(
                permissionState == .authorized ? .invalidSequence : .permissionBlocked
            )
            return
        }
        let duration = try SatelliteFrameCodec.captureDuration(from: payload)
        guard transition(from: [.ready], to: .capturing) else {
            try sendError(.invalidSequence)
            return
        }
        try writer.write(SatelliteFrame(kind: .captureStarted))
        do {
            try audioDevice.startCapture(maxDurationMilliseconds: duration)
        } catch {
            lock.withLock { currentState = .ready }
            try writer.write(
                SatelliteFrame(kind: .captureStopped, payload: Data([CaptureStopReason.failure.rawValue]))
            )
            try sendError(.audioUnavailable)
        }
    }

    private func handleStopCapture() {
        guard state == .capturing else {
            try? sendError(.invalidSequence)
            return
        }
        audioDevice.stopCapture(reason: .requested)
    }

    private func handlePlayback(_ payload: Data) throws {
        guard state == .ready else {
            try sendError(.invalidSequence)
            return
        }
        guard transition(from: [.ready], to: .playing) else {
            try sendError(.invalidSequence)
            return
        }
        try writer.write(SatelliteFrame(kind: .playbackStarted))
        do {
            try audioDevice.play(pcm: payload)
        } catch {
            lock.withLock { currentState = .ready }
            try writer.write(
                SatelliteFrame(kind: .playbackFinished, payload: Data([PlaybackStopReason.failure.rawValue]))
            )
            try sendError(.audioUnavailable)
        }
    }

    private func handleCancel() async {
        if state == .stopped || state == .stopping {
            try? sendError(.invalidSequence)
            return
        }
        lock.withLock { currentState = .cancelling }
        await withCheckedContinuation { continuation in
            audioDevice.cancel { [weak self] in
                guard let self else {
                    continuation.resume()
                    return
                }
                self.lock.withLock {
                    self.currentState = self.permissionState == .authorized
                        ? .ready
                        : .permissionBlocked
                }
                try? self.writer.write(SatelliteFrame(kind: .cancelled))
                continuation.resume()
            }
        }
    }

    private func handleShutdown() async {
        lock.withLock { currentState = .stopping }
        await withCheckedContinuation { continuation in
            audioDevice.shutdown { [weak self] in
                guard let self else {
                    continuation.resume()
                    return
                }
                try? self.writer.write(SatelliteFrame(kind: .shutdownComplete))
                self.lock.withLock { self.currentState = .stopped }
                continuation.resume()
            }
        }
    }

    private func receivedInput(_ data: Data) {
        guard state == .capturing,
              !data.isEmpty,
              data.count <= SatelliteProtocolV1.maximumAudioBytes,
              data.count.isMultiple(of: 2)
        else { return }
        sendFromCallback(SatelliteFrame(kind: .audioInput, payload: data))
    }

    private func captureStopped(_ reason: CaptureStopReason) {
        let previous = state
        guard previous == .capturing || previous == .cancelling else { return }
        if previous != .cancelling {
            lock.withLock { currentState = .ready }
        }
        sendFromCallback(
            SatelliteFrame(kind: .captureStopped, payload: Data([reason.rawValue]))
        )
    }

    private func playbackStopped(_ reason: PlaybackStopReason) {
        let previous = state
        guard previous == .playing || previous == .cancelling else { return }
        if previous != .cancelling {
            lock.withLock { currentState = .ready }
        }
        sendFromCallback(
            SatelliteFrame(kind: .playbackFinished, payload: Data([reason.rawValue]))
        )
    }

    private func deviceChanged() {
        guard state != .stopped && state != .stopping else { return }
        sendFromCallback(SatelliteFrame(kind: .deviceChanged))
    }

    private func sendError(_ code: SatelliteSafeErrorCode) throws {
        var payload = Data()
        payload.appendUInt16BE(code.rawValue)
        try writer.write(SatelliteFrame(kind: .error, payload: payload))
    }

    private func sendFromCallback(_ frame: SatelliteFrame) {
        do {
            try writer.write(frame)
        } catch {
            lock.withLock { currentState = .failed }
        }
    }

    private func transition(
        from allowed: Set<SatelliteRuntimeState>,
        to next: SatelliteRuntimeState
    ) -> Bool {
        lock.withLock {
            guard allowed.contains(currentState) else { return false }
            currentState = next
            return true
        }
    }
}

extension NSLock {
    @discardableResult
    fileprivate func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
