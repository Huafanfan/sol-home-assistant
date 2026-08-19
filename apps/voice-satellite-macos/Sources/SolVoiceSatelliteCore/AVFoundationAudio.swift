@preconcurrency import AVFoundation
import Foundation

public enum SatelliteAudioFailure: Error, Equatable, Sendable {
    case deviceUnavailable
    case formatUnsupported
    case conversionFailed
    case alreadyActive
}

public final class AVFoundationPermissionAuthorizer: @unchecked Sendable, MicrophonePermissionAuthorizing {
    public init() {}

    public func requestPermission() async -> MicrophonePermissionState {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized:
            return .authorized
        case .denied:
            return .denied
        case .restricted:
            return .restricted
        case .notDetermined:
            let granted = await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
            return granted ? .authorized : .denied
        @unknown default:
            return .restricted
        }
    }
}

public final class PCM16Converter: @unchecked Sendable {
    public static let outputSampleRate = 16_000.0
    public static let outputChannels: AVAudioChannelCount = 1

    private let converter: AVAudioConverter
    public let outputFormat: AVAudioFormat

    public init(inputFormat: AVAudioFormat) throws {
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0,
              let output = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: Self.outputSampleRate,
                  channels: Self.outputChannels,
                  interleaved: true
              ),
              let converter = AVAudioConverter(from: inputFormat, to: output)
        else {
            throw SatelliteAudioFailure.formatUnsupported
        }
        self.outputFormat = output
        self.converter = converter
    }

    public func convert(_ input: AVAudioPCMBuffer) throws -> Data {
        let ratio = Self.outputSampleRate / input.format.sampleRate
        let estimatedFrames = max(
            1,
            AVAudioFrameCount(ceil(Double(input.frameLength) * ratio)) + 32
        )
        guard let output = AVAudioPCMBuffer(
            pcmFormat: outputFormat,
            frameCapacity: estimatedFrames
        ) else {
            throw SatelliteAudioFailure.conversionFailed
        }

        let inputState = ConverterInputState()
        var conversionError: NSError?
        let status = converter.convert(to: output, error: &conversionError) {
            _, inputStatus in
            if inputState.supplied {
                inputStatus.pointee = .noDataNow
                return nil
            }
            inputState.supplied = true
            inputStatus.pointee = .haveData
            return input
        }
        guard status != .error, conversionError == nil else {
            throw SatelliteAudioFailure.conversionFailed
        }

        let byteCount = Int(output.frameLength) * MemoryLayout<Int16>.size
        guard byteCount > 0,
              byteCount <= SatelliteProtocolV1.maximumAudioBytes,
              let source = output.audioBufferList.pointee.mBuffers.mData
        else {
            throw SatelliteAudioFailure.conversionFailed
        }
        return Data(bytes: source, count: byteCount)
    }
}

public final class AVFoundationAudioDevice: @unchecked Sendable, SatelliteAudioDevice {
    private let lock = NSLock()
    private let callbackQueue = DispatchQueue(label: "sol.voice-satellite.audio-callbacks")

    private var inputCallback: (@Sendable (Data) -> Void)?
    private var captureStoppedCallback: (@Sendable (CaptureStopReason) -> Void)?
    private var playbackStoppedCallback: (@Sendable (PlaybackStopReason) -> Void)?
    private var deviceChangedCallback: (@Sendable () -> Void)?

    private var captureEngine: AVAudioEngine?
    private var captureLimit: DispatchWorkItem?
    private var captureObserver: NSObjectProtocol?
    private var playbackEngine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var playbackObserver: NSObjectProtocol?
    private var playbackActive = false
    private var playbackIdleCleanup: DispatchWorkItem?

    public init() {}

    public var onInputFrame: (@Sendable (Data) -> Void)? {
        get { lock.withAudioLock { inputCallback } }
        set { lock.withAudioLock { inputCallback = newValue } }
    }

    public var onCaptureStopped: (@Sendable (CaptureStopReason) -> Void)? {
        get { lock.withAudioLock { captureStoppedCallback } }
        set { lock.withAudioLock { captureStoppedCallback = newValue } }
    }

    public var onPlaybackStopped: (@Sendable (PlaybackStopReason) -> Void)? {
        get { lock.withAudioLock { playbackStoppedCallback } }
        set { lock.withAudioLock { playbackStoppedCallback = newValue } }
    }

    public var onDeviceChanged: (@Sendable () -> Void)? {
        get { lock.withAudioLock { deviceChangedCallback } }
        set { lock.withAudioLock { deviceChangedCallback = newValue } }
    }

    public func startCapture(maxDurationMilliseconds: Int) throws {
        cleanupIdlePlayback()
        guard (1...30_000).contains(maxDurationMilliseconds) else {
            throw SatelliteAudioFailure.formatUnsupported
        }
        guard lock.withAudioLock({ captureEngine == nil }) else {
            throw SatelliteAudioFailure.alreadyActive
        }

        let engine = AVAudioEngine()
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        let converter = try PCM16Converter(inputFormat: inputFormat)
        input.installTap(onBus: 0, bufferSize: 1_024, format: inputFormat) {
            [weak self, converter] buffer, _ in
            guard let data = try? converter.convert(buffer), !data.isEmpty else { return }
            self?.onInputFrame?(data)
        }

        let observer = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil
        ) { [weak self] _ in
            self?.callbackQueue.async { [weak self] in
                self?.handleCaptureDeviceChange()
            }
        }
        let limit = DispatchWorkItem { [weak self] in
            self?.stopCapture(reason: .limit)
        }
        lock.withAudioLock {
            captureEngine = engine
            captureObserver = observer
            captureLimit = limit
        }

        do {
            engine.prepare()
            try engine.start()
            callbackQueue.asyncAfter(
                deadline: .now() + .milliseconds(maxDurationMilliseconds),
                execute: limit
            )
        } catch {
            lock.withAudioLock {
                captureEngine = nil
                captureObserver = nil
                captureLimit = nil
            }
            cleanupCapture(engine: engine, observer: observer, limit: limit)
            throw SatelliteAudioFailure.deviceUnavailable
        }
    }

    public func stopCapture(reason: CaptureStopReason) {
        let resources = lock.withAudioLock { () -> (AVAudioEngine, NSObjectProtocol?, DispatchWorkItem?)? in
            guard let engine = captureEngine else { return nil }
            let value = (engine, captureObserver, captureLimit)
            captureEngine = nil
            captureObserver = nil
            captureLimit = nil
            return value
        }
        guard let (engine, observer, limit) = resources else { return }
        cleanupCapture(engine: engine, observer: observer, limit: limit)
        onCaptureStopped?(reason)
    }

    public func play(pcm: Data) throws {
        guard !pcm.isEmpty,
              pcm.count <= SatelliteProtocolV1.maximumAudioBytes,
              pcm.count.isMultiple(of: 2),
              let format = AVAudioFormat(
                  commonFormat: .pcmFormatInt16,
                  sampleRate: PCM16Converter.outputSampleRate,
                  channels: PCM16Converter.outputChannels,
                  interleaved: true
              )
        else {
            throw SatelliteAudioFailure.formatUnsupported
        }

        let frames = AVAudioFrameCount(pcm.count / MemoryLayout<Int16>.size)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames),
              let destination = buffer.mutableAudioBufferList.pointee.mBuffers.mData
        else {
            throw SatelliteAudioFailure.formatUnsupported
        }
        buffer.frameLength = frames
        pcm.copyBytes(to: destination.assumingMemoryBound(to: UInt8.self), count: pcm.count)

        var alreadyActive = false
        let existing = lock.withAudioLock { () -> (AVAudioEngine, AVAudioPlayerNode, NSObjectProtocol?)? in
            guard !playbackActive else {
                alreadyActive = true
                return nil
            }
            playbackIdleCleanup?.cancel()
            playbackIdleCleanup = nil
            playbackActive = true
            guard let engine = playbackEngine,
                  let existingPlayer = self.player
            else { return nil }
            return (engine, existingPlayer, playbackObserver)
        }
        if alreadyActive {
            throw SatelliteAudioFailure.alreadyActive
        }

        let resources: (AVAudioEngine, AVAudioPlayerNode, NSObjectProtocol?)
        if let existing {
            resources = existing
        } else {
            let engine = AVAudioEngine()
            let player = AVAudioPlayerNode()
            engine.attach(player)
            engine.connect(player, to: engine.mainMixerNode, format: format)
            let observer = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self] _ in
                self?.callbackQueue.async { [weak self] in
                    self?.handlePlaybackDeviceChange()
                }
            }
            lock.withAudioLock {
                playbackEngine = engine
                self.player = player
                playbackObserver = observer
            }
            resources = (engine, player, observer)
        }

        let (engine, player, observer) = resources

        do {
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) {
                [weak self] _ in
                self?.callbackQueue.async { [weak self] in
                    self?.completePlaybackBuffer()
                }
            }
            if !engine.isRunning {
                engine.prepare()
                try engine.start()
            }
            if !player.isPlaying {
                player.play()
            }
        } catch {
            lock.withAudioLock {
                if playbackEngine === engine {
                    playbackEngine = nil
                    self.player = nil
                    playbackObserver = nil
                }
                playbackActive = false
                playbackIdleCleanup?.cancel()
                playbackIdleCleanup = nil
            }
            cleanupPlayback(engine: engine, player: player, observer: observer)
            throw SatelliteAudioFailure.deviceUnavailable
        }
    }

    public func stopPlayback(reason: PlaybackStopReason) {
        finishPlayback(reason: reason)
    }

    public func cancel(completion: @escaping @Sendable () -> Void) {
        stopCapture(reason: .cancelled)
        stopPlayback(reason: .cancelled)
        completion()
    }

    public func shutdown(completion: @escaping @Sendable () -> Void) {
        stopCapture(reason: .cancelled)
        stopPlayback(reason: .cancelled)
        completion()
    }

    private func handleCaptureDeviceChange() {
        onDeviceChanged?()
        stopCapture(reason: .deviceChanged)
    }

    private func handlePlaybackDeviceChange() {
        onDeviceChanged?()
        stopPlayback(reason: .deviceChanged)
    }

    private func finishPlayback(reason: PlaybackStopReason) {
        let result = lock.withAudioLock { () -> ((AVAudioEngine, AVAudioPlayerNode, NSObjectProtocol?), (@Sendable (PlaybackStopReason) -> Void)?, Bool)? in
            guard let engine = playbackEngine, let player else { return nil }
            let resources = (engine, player, playbackObserver)
            let callback = playbackStoppedCallback
            let wasActive = playbackActive
            playbackEngine = nil
            self.player = nil
            playbackObserver = nil
            playbackActive = false
            playbackIdleCleanup?.cancel()
            playbackIdleCleanup = nil
            return (resources, callback, wasActive)
        }
        guard let ((engine, player, observer), callback, wasActive) = result else { return }
        cleanupPlayback(engine: engine, player: player, observer: observer)
        if wasActive {
            callback?(reason)
        }
    }

    private func completePlaybackBuffer() {
        let result = lock.withAudioLock { () -> ((@Sendable (PlaybackStopReason) -> Void)?, DispatchWorkItem)? in
            guard playbackActive, playbackEngine != nil, player != nil else { return nil }
            playbackActive = false
            playbackIdleCleanup?.cancel()
            let cleanup = DispatchWorkItem { [weak self] in
                self?.cleanupIdlePlayback()
            }
            playbackIdleCleanup = cleanup
            return (playbackStoppedCallback, cleanup)
        }
        guard let (callback, cleanup) = result else { return }
        callback?(.completed)
        callbackQueue.asyncAfter(deadline: .now() + .milliseconds(500), execute: cleanup)
    }

    private func cleanupIdlePlayback() {
        let resources = lock.withAudioLock { () -> (AVAudioEngine, AVAudioPlayerNode, NSObjectProtocol?)? in
            guard !playbackActive,
                  let engine = playbackEngine,
                  let player
            else { return nil }
            let value = (engine, player, playbackObserver)
            playbackEngine = nil
            self.player = nil
            playbackObserver = nil
            playbackIdleCleanup?.cancel()
            playbackIdleCleanup = nil
            return value
        }
        guard let (engine, player, observer) = resources else { return }
        cleanupPlayback(engine: engine, player: player, observer: observer)
    }

    private func cleanupCapture(
        engine: AVAudioEngine,
        observer: NSObjectProtocol?,
        limit: DispatchWorkItem?
    ) {
        limit?.cancel()
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
    }

    private func cleanupPlayback(
        engine: AVAudioEngine,
        player: AVAudioPlayerNode,
        observer: NSObjectProtocol?
    ) {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        player.stop()
        engine.stop()
        engine.detach(player)
    }
}

private final class ConverterInputState: @unchecked Sendable {
    var supplied = false
}

private extension NSLock {
    @discardableResult
    func withAudioLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
