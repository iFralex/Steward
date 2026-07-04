// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "StewardLauncher",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "StewardLauncher", targets: ["StewardLauncher"]),
    ],
    targets: [
        .executableTarget(name: "StewardLauncher"),
    ]
)
