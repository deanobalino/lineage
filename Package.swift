// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "Lineage",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(name: "Lineage", targets: ["Lineage"]),
        .executable(name: "lineage-capture", targets: ["lineage-capture"])
    ],
    targets: [
        .target(name: "LineageCore"),
        .executableTarget(
            name: "Lineage",
            dependencies: ["LineageCore"],
            resources: [.process("Resources")]
        ),
        .executableTarget(
            name: "lineage-capture",
            dependencies: ["LineageCore"]
        )
    ]
)
