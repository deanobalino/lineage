import XCTest
@testable import LineageCore

final class ProvenanceGraphTests: XCTestCase {
    func testGraphLinksSessionEvidenceToCodeRanges() throws {
        let repo = try makeFixtureRepo()
        let session = makeSession()
        let graph = ProvenanceGraphBuilder().build(repoRoot: repo, sessions: [session])

        XCTAssertTrue(graph.nodes.contains { $0.kind == .repository })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .commit && $0.commitSHA == "abc123" })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .file && $0.filePath == "Sources/App.swift" })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .range && $0.filePath == "Sources/App.swift" && $0.startLine == 2 && $0.endLine == 3 && $0.contentHash != nil })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .line && $0.filePath == "Sources/App.swift" && $0.startLine == 2 && $0.endLine == 2 && $0.contentHash != nil })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .prompt && $0.sessionID == "session-1" })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .tool && $0.sessionID == "session-1" })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .test && $0.sessionID == "session-1" })
        XCTAssertTrue(graph.nodes.contains { $0.kind == .finalMessage && $0.sessionID == "session-1" })

        let repoPath = repo.path
        let commitID = ProvenanceID.commit(repoRoot: repoPath, sha: "abc123")
        let fileID = ProvenanceID.file(repoRoot: repoPath, commitSHA: "abc123", path: "Sources/App.swift")
        let rangeID = ProvenanceID.range(repoRoot: repoPath, commitSHA: "abc123", path: "Sources/App.swift", start: 2, end: 3)
        let lineHash = ProvenanceID.hash("let answer = 42")
        let lineID = ProvenanceID.line(repoRoot: repoPath, commitSHA: "abc123", path: "Sources/App.swift", line: 2, contentHash: lineHash)
        let turnID = ProvenanceID.turn(sessionID: "session-1", turnID: "turn-1")
        let promptID = ProvenanceID.evidence(kind: .prompt, sessionID: "session-1", stableKey: "prompt-\(ProvenanceID.hash("Add an answer constant."))")
        let toolID = ProvenanceID.evidence(kind: .tool, sessionID: "session-1", stableKey: "tool-0")
        XCTAssertTrue(graph.edges.contains { $0.from == commitID && $0.to == fileID && $0.kind == .contains })
        XCTAssertTrue(graph.edges.contains { $0.from == fileID && $0.to == rangeID && $0.kind == .contains })
        XCTAssertTrue(graph.edges.contains { $0.from == ProvenanceID.session("session-1") && $0.to == lineID && $0.kind == .touches })
        XCTAssertTrue(graph.edges.contains { $0.from == turnID && $0.to == promptID && $0.kind == .contains })
        XCTAssertTrue(graph.edges.contains { $0.from == turnID && $0.to == toolID && $0.kind == .contains })

        let codeNodes = graph.linkedCodeNodes(sessionID: "session-1")
        XCTAssertTrue(codeNodes.contains { $0.kind == .range && $0.filePath == "Sources/App.swift" })
        XCTAssertTrue(codeNodes.contains { $0.kind == .line && $0.filePath == "Sources/App.swift" && $0.startLine == 2 })
        XCTAssertTrue(graph.edges.contains { $0.kind == .evidencedBy })
    }

    func testAgentTraceRecordMapsSessionRangesAndLineageMetadata() throws {
        let repo = try makeFixtureRepo()
        let session = makeSession()

        let record = try XCTUnwrap(AgentTraceExporter().record(repoRoot: repo, session: session))

        XCTAssertEqual(record.version, "0.1.0")
        XCTAssertEqual(record.vcs?.type, "git")
        XCTAssertEqual(record.vcs?.revision, "abc123")
        XCTAssertEqual(record.tool?.name, "codex")
        XCTAssertEqual(record.files.map(\.path), ["Sources/App.swift"])
        XCTAssertEqual(record.files.first?.conversations.first?.contributor.type, "ai")
        XCTAssertEqual(record.files.first?.conversations.first?.contributor.modelID, "gpt-test")
        XCTAssertEqual(record.files.first?.conversations.first?.ranges.first?.startLine, 2)
        XCTAssertEqual(record.files.first?.conversations.first?.ranges.first?.endLine, 3)
        XCTAssertNotNil(record.files.first?.conversations.first?.ranges.first?.contentHash)

        let lineageMetadata = try XCTUnwrap(record.metadata?["dev.lineage"])
        guard case .object(let object) = lineageMetadata else {
            return XCTFail("Expected dev.lineage metadata object")
        }
        XCTAssertEqual(object["session_id"]?.stringValue, "session-1")
        XCTAssertEqual(object["provider"]?.stringValue, "codex")
        XCTAssertEqual(object["tests_result"]?.stringValue, "passed")
        if case .some(.bool(let hasRawPayload)) = object["has_raw_telemetry_payload"] {
            XCTAssertFalse(hasRawPayload)
        } else {
            XCTFail("Expected has_raw_telemetry_payload bool")
        }
    }

    func testStoreMatchesSessionByLineRangeAndCommitFallback() throws {
        let repo = try makeFixtureRepo()
        let store = ProvenanceStore(repoRoot: repo)
        let session = makeSession()
        try store.write(session: session)

        let direct = store.matchingSession(file: "Sources/App.swift", line: 2)
        XCTAssertEqual(direct?.sessionID, "session-1")

        let fallback = store.matchingSession(file: "Sources/App.swift", line: 99, commitSHA: "abc123")
        XCTAssertEqual(fallback?.sessionID, "session-1")

        let noMatch = store.matchingSession(file: "Sources/Other.swift", line: 99, commitSHA: "abc123")
        XCTAssertNil(noMatch)
    }

    func testSessionEvidenceGroupsTimelineByEvidenceType() throws {
        let bundle = SessionEvidenceLoader().load(session: makeSession())
        let groups = Dictionary(grouping: bundle.timeline) { $0.group }

        XCTAssertEqual(groups["Prompt"]?.count, 1)
        XCTAssertEqual(groups["Tool"]?.count, 2)
        XCTAssertEqual(groups["Decision"]?.count, 1)
        XCTAssertEqual(groups["Constraint"]?.count, 1)
        XCTAssertEqual(groups["Test"]?.count, 1)
        XCTAssertEqual(groups["Final response"]?.count, 1)
    }

    func testSessionTelemetryEnvelopeConvertsToProvenanceSession() throws {
        let telemetry = SessionTelemetryEnvelope(
            provider: "tapes-proxy",
            sessionID: "proxy-session-1",
            turnID: "proxy-turn-1",
            source: "proxy-session-telemetry",
            actor: "Proxy Agent",
            model: "proxy/model",
            prompt: "Explain and edit the selected range.",
            events: [
                SessionTelemetryEvent(kind: .tool, title: "Edit", body: "Edited file.", command: "apply edit"),
                SessionTelemetryEvent(kind: .decision, title: "user_selected_option", body: "Choose minimal patch.", selectedOptionText: "Minimal patch"),
                SessionTelemetryEvent(kind: .constraint, title: "Spec", body: "Keep app code-first.", filePath: "SPEC.md", startLine: 2, endLine: 4),
                SessionTelemetryEvent(kind: .test, title: "swift test", body: "Ran tests.", command: "swift test", result: "passed"),
                SessionTelemetryEvent(kind: .finalResponse, title: "Final", body: "Done.")
            ],
            filesEdited: ["Sources/App.swift"],
            lineRanges: [LineRange(file: "Sources/App.swift", start: 2, end: 3, confidence: 0.88, label: "Proxy telemetry")],
            commitSHA: "def456",
            rawPayload: .object(["source": .string("fixture")])
        )

        let session = telemetry.provenanceSession()

        XCTAssertEqual(session.provider, "tapes-proxy")
        XCTAssertEqual(session.sessionID, "proxy-session-1")
        XCTAssertEqual(session.source, "proxy-session-telemetry")
        XCTAssertEqual(session.prompt, "Explain and edit the selected range.")
        XCTAssertEqual(session.commandsRun, ["apply edit"])
        XCTAssertEqual(session.testsRun, ["swift test"])
        XCTAssertEqual(session.testsResult, "passed")
        XCTAssertEqual(session.decisions.first?.selectedOptionText, "Minimal patch")
        XCTAssertEqual(session.externalConstraints.first?.locationLabel, "SPEC.md:2-4")
        XCTAssertEqual(session.lineRanges.first?.label, "Proxy telemetry")
        XCTAssertNotNil(session.rawTelemetryPayload)
    }

    private func makeFixtureRepo() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("LineageCoreTests-\(UUID().uuidString)", isDirectory: true)
        let sources = root.appendingPathComponent("Sources", isDirectory: true)
        try FileManager.default.createDirectory(at: sources, withIntermediateDirectories: true)
        try """
        import Foundation
        let answer = 42
        print(answer)
        """.write(to: sources.appendingPathComponent("App.swift"), atomically: true, encoding: .utf8)
        return root
    }

    private func makeSession() -> ProvenanceSession {
        ProvenanceSession(
            sessionID: "session-1",
            turnID: "turn-1",
            model: "gpt-test",
            prompt: "Add an answer constant.",
            toolsUsed: ["Edit"],
            commandsRun: ["swift test"],
            filesEdited: ["Sources/App.swift"],
            testsRun: ["swift test"],
            testsResult: "passed",
            permissionRequests: [],
            decisions: [
                DecisionRecord(kind: "user_selected_option", context: "Choose minimal implementation.", selectedOptionText: "Use a constant.")
            ],
            externalConstraints: [
                ExternalConstraint(filePath: "README.md", summary: "Keep sample minimal.", source: "tool_call")
            ],
            lastAssistantMessage: "Implemented the constant and ran tests.",
            gitDiff: "@@ -1,2 +1,3 @@",
            commitSHA: "abc123",
            commitMessage: "Add answer constant",
            reasoningSummary: "Fixture session",
            lineRanges: [
                LineRange(file: "Sources/App.swift", start: 2, end: 3, confidence: 0.91, label: "Recorded")
            ]
        )
    }
}
