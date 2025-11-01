// swift-tools-version: 5.9
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "PageSpaceMobile",
    platforms: [
        .iOS(.v17)
    ],
    products: [
        .library(
            name: "PageSpaceMobile",
            targets: ["PageSpaceMobile"]
        )
    ],
    dependencies: [
        // Socket.IO for real-time communication
        .package(
            url: "https://github.com/socketio/socket.io-client-swift",
            from: "16.0.0"
        ),
        // Markdown rendering
        .package(
            url: "https://github.com/gonzalezreal/swift-markdown-ui",
            from: "2.0.0"
        ),
        // Async algorithms for stream processing
        .package(
            url: "https://github.com/apple/swift-async-algorithms",
            from: "1.0.0"
        )
    ],
    targets: [
        .target(
            name: "PageSpaceMobile",
            dependencies: [
                .product(name: "SocketIO", package: "socket.io-client-swift"),
                .product(name: "MarkdownUI", package: "swift-markdown-ui"),
                .product(name: "AsyncAlgorithms", package: "swift-async-algorithms")
            ],
            path: "PageSpaceMobile"
        ),
        .testTarget(
            name: "PageSpaceMobileTests",
            dependencies: ["PageSpaceMobile"],
            path: "PageSpaceMobileTests"
        )
    ]
)
