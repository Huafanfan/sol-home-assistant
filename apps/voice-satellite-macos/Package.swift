// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "SolVoiceSatellite",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SolVoiceSatelliteCore", targets: ["SolVoiceSatelliteCore"]),
        .executable(name: "sol-voice-satellite", targets: ["SolVoiceSatelliteExecutable"]),
    ],
    targets: [
        .target(name: "SolVoiceSatelliteCore"),
        .executableTarget(
            name: "SolVoiceSatelliteExecutable",
            dependencies: ["SolVoiceSatelliteCore"]
        ),
        .testTarget(
            name: "SolVoiceSatelliteCoreTests",
            dependencies: ["SolVoiceSatelliteCore"]
        ),
    ]
)
