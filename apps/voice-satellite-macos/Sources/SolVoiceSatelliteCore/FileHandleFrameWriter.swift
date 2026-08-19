import Foundation

public final class FileHandleFrameWriter: @unchecked Sendable, SatelliteFrameWriting {
    private let handle: FileHandle
    private let lock = NSLock()

    public init(handle: FileHandle) {
        self.handle = handle
    }

    public func write(_ frame: SatelliteFrame) throws {
        let encoded = try SatelliteFrameCodec.encode(frame)
        try lock.withWriterLock {
            try handle.write(contentsOf: encoded)
        }
    }
}

private extension NSLock {
    func withWriterLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
