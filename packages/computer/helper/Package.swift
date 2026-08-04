// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "OdeComputerHelper",
    platforms: [
        // PackageDescription 5.10 does not expose `.v15`; the app bundle's
        // LSMinimumSystemVersion remains the product-level macOS 15 gate.
        .macOS(.v14),
    ],
    products: [
        .executable(name: "OdeComputerHelper", targets: ["OdeComputerHelper"]),
    ],
    targets: [
        .executableTarget(
            name: "OdeComputerHelper",
            path: "Sources/OdeComputerHelper",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("ApplicationServices"),
                .linkedFramework("CoreGraphics"),
                .linkedFramework("CoreText"),
                .linkedFramework("ImageIO"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Security"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
    ]
)
