import Foundation
import XCTest
@testable import SolVoiceSatelliteCore

final class LocalActivationControllerTests: XCTestCase {
    func testPreWakeAndSpeechStartFramesNeverBecomeGatewayAudio() {
        let wake = ScriptedWakeDetector([.noWake, .detected])
        let vad = ScriptedSpeechBoundaryDetector([.speechStarted, .none, .speechEnded])
        let controller = LocalActivationController(
            wakeDetector: wake,
            speechBoundaryDetector: vad,
            configuration: LocalActivationConfiguration(maximumBufferedBytes: 8)
        )

        XCTAssertEqual(controller.startListening(), [.listeningStarted])
        XCTAssertEqual(controller.process(Data([0, 0])), [])
        XCTAssertEqual(controller.bufferedByteCount, 2)
        XCTAssertEqual(controller.process(Data([1, 0])), [.wakeDetected])
        XCTAssertEqual(controller.state, .awakeLocal)
        XCTAssertEqual(controller.bufferedByteCount, 4)

        XCTAssertEqual(controller.process(Data([2, 0])), [.speechStarted])
        XCTAssertEqual(controller.state, .asrStreaming)
        XCTAssertEqual(controller.bufferedByteCount, 0)
        XCTAssertEqual(controller.process(Data([3, 0])), [.audioForGateway(Data([3, 0]))])
        XCTAssertEqual(controller.process(Data([4, 0])), [.speechEnded])
        XCTAssertEqual(controller.state, .closing)
        XCTAssertEqual(controller.bufferedByteCount, 0)

        XCTAssertEqual(controller.completeTurn(), [.listeningResumed])
        XCTAssertEqual(controller.state, .localListening)
    }

    func testFalseWakeAndStopClearBoundedLocalBufferWithoutGatewayAudio() {
        let controller = LocalActivationController(
            wakeDetector: ScriptedWakeDetector([.detected]),
            speechBoundaryDetector: ScriptedSpeechBoundaryDetector([]),
            configuration: LocalActivationConfiguration(maximumBufferedBytes: 4)
        )

        XCTAssertEqual(controller.startListening(), [.listeningStarted])
        XCTAssertEqual(controller.process(Data([1, 0])), [.wakeDetected])
        XCTAssertEqual(controller.bufferedByteCount, 2)
        XCTAssertEqual(controller.wakeTimedOut(), [.falseWake])
        XCTAssertEqual(controller.state, .localListening)
        XCTAssertEqual(controller.bufferedByteCount, 0)

        XCTAssertEqual(controller.process(Data([2, 0])), [])
        XCTAssertEqual(controller.stop(), [.stopped(.userRequested)])
        XCTAssertEqual(controller.state, .stopped)
        XCTAssertEqual(controller.bufferedByteCount, 0)
    }

    func testDetectorFailureStopsAndClearsWithoutDisclosingInput() {
        let controller = LocalActivationController(
            wakeDetector: FailingWakeDetector(),
            speechBoundaryDetector: ScriptedSpeechBoundaryDetector([])
        )

        _ = controller.startListening()
        XCTAssertEqual(controller.process(Data([9, 0])), [.failed(.wakeDetector)])
        XCTAssertEqual(controller.state, .stopped)
        XCTAssertEqual(controller.bufferedByteCount, 0)
    }
}

final class LocalActivationProtocolTests: XCTestCase {
    func testV2CapabilityHelloHasExplicitVersionAndDirection() throws {
        let capabilities = try SatelliteFrameCodec.activationCapabilitiesPayload(.localActivation)
        let hello = SatelliteFrame(
            version: .localActivationV2,
            kind: .hello,
            payload: capabilities
        )
        let encoded = try SatelliteFrameCodec.encode(hello)

        XCTAssertEqual(Array(encoded.prefix(12)), [
            0x53, 0x4f, 0x4c, 0x31, 2, 1, 0, 0, 0, 0, 0, 1,
        ])
        var decoder = SatelliteFrameDecoder()
        XCTAssertEqual(try decoder.append(encoded), [hello])
        XCTAssertEqual(
            try SatelliteFrameCodec.activationCapabilities(from: capabilities),
            .localActivation
        )
        XCTAssertNoThrow(try SatelliteFrameCodec.validateSatelliteFrame(hello))
        XCTAssertNoThrow(
            try SatelliteFrameCodec.validateGatewayFrame(
                SatelliteFrame(version: .localActivationV2, kind: .startLocalListening)
            )
        )

        XCTAssertThrowsError(
            try SatelliteFrameCodec.encode(
                SatelliteFrame(
                    version: .localActivationV2,
                    kind: .hello,
                    payload: Data([0x80])
                )
            )
        ) { error in
            XCTAssertEqual(error as? SatelliteProtocolFailure, .invalidPayload)
        }
        XCTAssertThrowsError(
            try SatelliteFrameCodec.validateSatelliteFrame(
                SatelliteFrame(version: .localActivationV2, kind: .startLocalListening)
            )
        ) { error in
            XCTAssertEqual(error as? SatelliteProtocolFailure, .invalidDirection)
        }
    }
}

private final class ScriptedWakeDetector: WakeDetecting {
    private var detections: [WakeDetection]

    init(_ detections: [WakeDetection]) {
        self.detections = detections
    }

    func process(_ pcm: Data) throws -> WakeDetection {
        guard !detections.isEmpty else { return .noWake }
        return detections.removeFirst()
    }

    func reset() {}
}

private final class ScriptedSpeechBoundaryDetector: SpeechBoundaryDetecting {
    private var boundaries: [SpeechBoundary]

    init(_ boundaries: [SpeechBoundary]) {
        self.boundaries = boundaries
    }

    func process(_ pcm: Data) throws -> SpeechBoundary {
        guard !boundaries.isEmpty else { return .none }
        return boundaries.removeFirst()
    }

    func reset() {}
}

private final class FailingWakeDetector: WakeDetecting {
    func process(_ pcm: Data) throws -> WakeDetection {
        throw DetectorFailure.failed
    }

    func reset() {}
}

private enum DetectorFailure: Error {
    case failed
}
