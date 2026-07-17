import XCTest
@testable import LineageCore

final class CodingHarnessPluginTests: XCTestCase {
    func testRegistryExposesCodexAndCopilotCLIPlugins() {
        let descriptors = CodingHarnessPluginRegistry.shared.descriptors

        XCTAssertEqual(Set(descriptors.map(\.id)), Set([AIProvider.codex.id, AIProvider.githubCopilot.id]))
        XCTAssertEqual(
            CodingHarnessPluginRegistry.shared.plugin(for: AIProvider.githubCopilot.id)?.descriptor.configurationRelativePath,
            ".github/hooks/lineage-copilot.json"
        )
    }

    func testCopilotConfigUsesRepositoryHooksAndExplicitProviderRouting() throws {
        let config = HookConfig.githubCopilotCLIConfig(command: "/tmp/lineage capture")
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(config.utf8)) as? [String: Any]
        )
        let hooks = try XCTUnwrap(object["hooks"] as? [String: Any])

        for event in ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"] {
            let entries = try XCTUnwrap(hooks[event] as? [[String: Any]])
            let first = try XCTUnwrap(entries.first)
            XCTAssertEqual(first["command"] as? String, "/tmp/lineage capture")
            XCTAssertEqual((first["env"] as? [String: String])?["LINEAGE_PROVIDER"], AIProvider.githubCopilot.id)
        }
    }

    func testCopilotAdapterKeepsProviderAndNativeEvidence() throws {
        let repo = try makeFixtureRepo()
        let raw: [String: Any] = [
            "hook_event_name": "PostToolUse",
            "session_id": "copilot-session-1",
            "cwd": repo.path,
            "tool_name": "Edit",
            "tool_input": ["file_path": "Sources/App.swift"],
            "tool_result": ["result_type": "success", "text_result_for_llm": "updated"]
        ]

        let event = GitHubCopilotProviderAdapter().canonicalEvent(
            rawObject: raw,
            payloadObject: raw,
            cwd: repo,
            repoRoot: repo,
            environment: [:],
            git: GitService()
        )

        XCTAssertEqual(event.provider, AIProvider.githubCopilot.id)
        XCTAssertEqual(event.actor, AIProvider.githubCopilot.displayName)
        XCTAssertEqual(event.sessionID, "copilot-session-1")
        XCTAssertEqual(event.eventType, CanonicalEventType.postToolUse)
        XCTAssertEqual(event.payload.toolName, "Edit")
        XCTAssertEqual(event.payload.toolInput?["file_path"]?.stringValue, "Sources/App.swift")
        XCTAssertEqual(event.payload.toolResponse?["text_result_for_llm"]?.stringValue, "updated")
    }

    func testStoreReportsMultipleConfiguredHarnesses() throws {
        let repo = try makeFixtureRepo()
        for plugin in CodingHarnessPluginRegistry.shared.plugins {
            let url = plugin.configurationURL(repoRoot: repo)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try plugin.hookConfiguration(command: "lineage-capture").write(to: url, atomically: true, encoding: .utf8)
        }

        let summary = ProvenanceStore(repoRoot: repo).summary(files: [])

        XCTAssertTrue(summary.configured)
        XCTAssertEqual(Set(summary.configuredHarnesses), Set(["Codex", "GitHub Copilot CLI"]))
    }

    private func makeFixtureRepo() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("LineageHarnessTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
