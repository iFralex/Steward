// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "StewardLauncher",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "StewardLauncher", targets: ["StewardLauncher"]),
    ],
    targets: [
        // Package copies the standard .lproj catalogs into the main .app so
        // macOS can also localize native privacy usage descriptions.
        .executableTarget(name: "StewardLauncher", exclude: ["Resources"]),
        .testTarget(name: "StewardLauncherTests", dependencies: ["StewardLauncher"]),
    ]
)
