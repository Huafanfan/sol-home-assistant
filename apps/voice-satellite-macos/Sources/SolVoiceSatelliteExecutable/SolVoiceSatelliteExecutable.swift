import Darwin
import Foundation
import SolVoiceSatelliteCore

@main
struct SolVoiceSatelliteExecutable {
    static func main() async {
        let writer = FileHandleFrameWriter(handle: .standardOutput)
        let runtime = SatelliteRuntime(
            permissionAuthorizer: AVFoundationPermissionAuthorizer(),
            audioDevice: AVFoundationAudioDevice(),
            writer: writer
        )
        var decoder = SatelliteFrameDecoder()

        do {
            try runtime.start()
            while runtime.state != .stopped {
                var bytes = [UInt8](repeating: 0, count: 65_548)
                let count = bytes.withUnsafeMutableBytes { buffer in
                    Darwin.read(STDIN_FILENO, buffer.baseAddress, buffer.count)
                }
                guard count >= 0 else { throw SatelliteExecutableFailure.readFailed }
                guard count > 0 else { break }
                let chunk = Data(bytes.prefix(count))
                for frame in try decoder.append(chunk) {
                    try await runtime.handle(frame)
                    if frame.kind == .shutdown {
                        return
                    }
                }
            }
            try decoder.finish()
            if runtime.state != .stopped {
                try await runtime.handle(SatelliteFrame(kind: .shutdown))
            }
        } catch {
            var payload = Data()
            payload.append(UInt8((SatelliteSafeErrorCode.protocolViolation.rawValue >> 8) & 0xff))
            payload.append(UInt8(SatelliteSafeErrorCode.protocolViolation.rawValue & 0xff))
            try? writer.write(SatelliteFrame(kind: .error, payload: payload))
            writeSafeDiagnostic("SOL_PROTOCOL_ERROR\n")
            Darwin.exit(1)
        }
    }

    private static func writeSafeDiagnostic(_ value: String) {
        try? FileHandle.standardError.write(contentsOf: Data(value.utf8))
    }
}

private enum SatelliteExecutableFailure: Error {
    case readFailed
}
