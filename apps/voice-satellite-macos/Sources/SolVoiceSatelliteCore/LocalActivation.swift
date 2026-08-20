import Foundation

/** A local-only wake detector. Implementations must never upload PCM. */
public protocol WakeDetecting: AnyObject {
    func process(_ pcm: Data) throws -> WakeDetection
    func reset()
}

public enum WakeDetection: Equatable, Sendable {
    case noWake
    case detected
}

/** A local-only VAD boundary detector. It does not interpret speech content. */
public protocol SpeechBoundaryDetecting: AnyObject {
    func process(_ pcm: Data) throws -> SpeechBoundary
    func reset()
}

public enum SpeechBoundary: Equatable, Sendable {
    case none
    case speechStarted
    case speechEnded
}

public struct LocalActivationConfiguration: Equatable, Sendable {
    public let maximumBufferedBytes: Int

    public init(maximumBufferedBytes: Int = 32_000) {
        precondition(maximumBufferedBytes > 0)
        self.maximumBufferedBytes = maximumBufferedBytes
    }
}

public enum LocalActivationState: Equatable, Sendable {
    case stopped
    case localListening
    case awakeLocal
    case asrStreaming
    case closing
}

public enum LocalActivationStopReason: Equatable, Sendable {
    case userRequested
    case cancelled
    case deviceChanged
    case failure
}

public enum LocalActivationFailure: Equatable, Sendable {
    case invalidSequence
    case invalidAudio
    case wakeDetector
    case speechBoundary
}

/**
 * `audioForGateway` is intentionally impossible before `speechStarted`; no
 * pre-wake, wake-word, or VAD-waiting PCM can cross this local boundary.
 */
public enum LocalActivationEvent: Equatable, Sendable {
    case listeningStarted
    case listeningResumed
    case wakeDetected
    case speechStarted
    case audioForGateway(Data)
    case speechEnded
    case falseWake
    case stopped(LocalActivationStopReason)
    case failed(LocalActivationFailure)
}

/**
 * Deterministic local activation state machine for VOICE-005's first slice.
 * It deliberately has no AVFoundation, process, network, logging, or provider
 * dependency so tests can prove the privacy gate without a microphone/model.
 */
public final class LocalActivationController {
    private let wakeDetector: WakeDetecting
    private let speechBoundaryDetector: SpeechBoundaryDetecting
    private let localWindow: BoundedLocalAudioWindow

    public private(set) var state: LocalActivationState = .stopped

    public init(
        wakeDetector: WakeDetecting,
        speechBoundaryDetector: SpeechBoundaryDetecting,
        configuration: LocalActivationConfiguration = LocalActivationConfiguration()
    ) {
        self.wakeDetector = wakeDetector
        self.speechBoundaryDetector = speechBoundaryDetector
        self.localWindow = BoundedLocalAudioWindow(
            maximumBytes: configuration.maximumBufferedBytes
        )
    }

    /** Exposes only size, never stored PCM, for bounded-memory assertions. */
    public var bufferedByteCount: Int {
        localWindow.byteCount
    }

    public func startListening() -> [LocalActivationEvent] {
        guard state == .stopped else {
            return [.failed(.invalidSequence)]
        }
        resetDetectorsAndBuffer()
        state = .localListening
        return [.listeningStarted]
    }

    /**
     * Feeds one local PCM frame. The caller receives an audio event only after
     * a previous VAD `speechStarted`; the triggering VAD frame remains local.
     */
    public func process(_ pcm: Data) -> [LocalActivationEvent] {
        guard pcm.count >= 2, pcm.count.isMultiple(of: 2) else {
            return fail(.invalidAudio)
        }

        switch state {
        case .stopped, .closing:
            return []
        case .localListening:
            localWindow.append(pcm)
            do {
                if try wakeDetector.process(pcm) == .detected {
                    speechBoundaryDetector.reset()
                    state = .awakeLocal
                    return [.wakeDetected]
                }
                return []
            } catch {
                return fail(.wakeDetector)
            }
        case .awakeLocal:
            localWindow.append(pcm)
            do {
                switch try speechBoundaryDetector.process(pcm) {
                case .none:
                    return []
                case .speechStarted:
                    localWindow.clear()
                    state = .asrStreaming
                    return [.speechStarted]
                case .speechEnded:
                    return resetAfterFalseWake()
                }
            } catch {
                return fail(.speechBoundary)
            }
        case .asrStreaming:
            do {
                if try speechBoundaryDetector.process(pcm) == .speechEnded {
                    localWindow.clear()
                    state = .closing
                    return [.speechEnded]
                }
                return [.audioForGateway(pcm)]
            } catch {
                return fail(.speechBoundary)
            }
        }
    }

    /** Called by the owning runtime's local no-speech timer, never by cloud. */
    public func wakeTimedOut() -> [LocalActivationEvent] {
        guard state == .awakeLocal else {
            return [.failed(.invalidSequence)]
        }
        return resetAfterFalseWake()
    }

    /** Called once the existing ASR → Gateway → TTS turn has fully closed. */
    public func completeTurn() -> [LocalActivationEvent] {
        guard state == .closing else {
            return [.failed(.invalidSequence)]
        }
        resetDetectorsAndBuffer()
        state = .localListening
        return [.listeningResumed]
    }

    public func stop(reason: LocalActivationStopReason = .userRequested) -> [LocalActivationEvent] {
        resetDetectorsAndBuffer()
        state = .stopped
        return [.stopped(reason)]
    }

    public func deviceChanged() -> [LocalActivationEvent] {
        stop(reason: .deviceChanged)
    }

    private func resetAfterFalseWake() -> [LocalActivationEvent] {
        resetDetectorsAndBuffer()
        state = .localListening
        return [.falseWake]
    }

    private func fail(_ failure: LocalActivationFailure) -> [LocalActivationEvent] {
        resetDetectorsAndBuffer()
        state = .stopped
        return [.failed(failure)]
    }

    private func resetDetectorsAndBuffer() {
        localWindow.clear()
        wakeDetector.reset()
        speechBoundaryDetector.reset()
    }
}

private final class BoundedLocalAudioWindow {
    private let maximumBytes: Int
    private var frames: [Data] = []

    private(set) var byteCount = 0

    init(maximumBytes: Int) {
        self.maximumBytes = maximumBytes
    }

    func append(_ frame: Data) {
        guard frame.count < maximumBytes else {
            clear()
            return
        }
        while byteCount + frame.count > maximumBytes, !frames.isEmpty {
            byteCount -= frames.removeFirst().count
        }
        frames.append(frame)
        byteCount += frame.count
    }

    func clear() {
        frames.removeAll(keepingCapacity: false)
        byteCount = 0
    }
}
