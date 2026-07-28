import Foundation
import XCTest
@testable import LineageCore

final class CompatibilityOracleTests: XCTestCase {
    func testLegacyCorpusCharacterizesCurrentReadersAndLinker() throws {
        let repo = try materializeFixtureRepository()
        let store = ProvenanceStore(repoRoot: repo)

        XCTAssertEqual(store.events().count, 9, "The malformed JSONL line must be skipped.")
        XCTAssertEqual(store.sessions().count, 1, "The historical session with missing optional fields must decode.")
        XCTAssertEqual(store.sessions().first?.provider, AIProvider.codex.id)
        XCTAssertEqual(store.sessions().first?.commandsRun, [])

        try ProvenanceLinker().link(repoRoot: repo)

        let sessions = store.sessions()
        XCTAssertEqual(Set(sessions.map(\.sessionID)), Set(["stored-legacy-session", "legacy-session", "copilot-session"]))
        let codex = try XCTUnwrap(sessions.first { $0.sessionID == "legacy-session" })
        XCTAssertEqual(codex.prompt, "Keep retries bounded.")
        XCTAssertEqual(codex.commandsRun, ["pytest tests/test_retry.py"])
        XCTAssertEqual(codex.decisions.first?.selectedOptionText, "Bounded retries")
        XCTAssertEqual(codex.externalConstraints.first?.locationLabel, "SPEC.md:4-8")
        XCTAssertEqual(codex.lineRanges.first?.file, "src/retry.py")

        let copilotEvents = store.events().filter { $0.provider == AIProvider.githubCopilot.id }
        XCTAssertEqual(copilotEvents.map(\.eventType), ["agent_stop", CanonicalEventType.sessionStop])
    }

    func testRedactionCorpusCharacterizesCurrentPolicy() throws {
        let cases = try redactionCases()
        for item in cases {
            XCTAssertEqual(SecretRedactor.redact(item.input), item.expected, item.id)
        }
    }

    func testEmitNormalizedCompatibilityOracle() throws {
        let outputEnvironment = ProcessInfo.processInfo.environment["LINEAGE_ORACLE_OUTPUT_DIR"]
        guard let outputEnvironment, !outputEnvironment.isEmpty else {
            throw XCTSkip("Set LINEAGE_ORACLE_OUTPUT_DIR to emit the retained compatibility oracle.")
        }

        let repo = try materializeFixtureRepository()
        let store = ProvenanceStore(repoRoot: repo)
        try ProvenanceLinker().link(repoRoot: repo)

        var sessions = store.sessions()
        if let index = sessions.firstIndex(where: { $0.sessionID == "legacy-session" }) {
            sessions[index].transcriptPath = transcriptFixtureURL.path
        }
        let events = store.events().sorted { $0.id < $1.id }
        let graph = ProvenanceGraphBuilder().build(
            repoRoot: URL(fileURLWithPath: "/fixture/repo"),
            sessions: sessions,
            events: events
        )
        let evidenceSession = try XCTUnwrap(sessions.first { $0.sessionID == "legacy-session" })
        var evidence = SessionEvidenceLoader().load(session: evidenceSession)
        evidence.transcriptPath = "/fixture/transcripts/codex-session.jsonl"

        var traces = AgentTraceExporter().records(
            repoRoot: URL(fileURLWithPath: "/fixture/repo"),
            sessions: sessions
        )
        for index in traces.indices {
            traces[index].timestamp = Date(timeIntervalSince1970: 0)
        }

        let redaction = try redactionCases().map { item in
            [
                "id": item.id,
                "actual": SecretRedactor.redact(item.input),
                "expected": item.expected
            ]
        }
        let oracle = normalize([
            "schema_version": 1,
            "baseline": "swift-lineage-core",
            "events": try jsonObject(events),
            "sessions": try jsonObject(sessions),
            "graph": try jsonObject(graph),
            "session_evidence": try jsonObject(evidence),
            "session_markdown": SessionEvidenceExporter.markdown(bundle: evidence),
            "session_json": String(data: try SessionEvidenceExporter.jsonData(bundle: evidence), encoding: .utf8) ?? "",
            "agent_trace": try jsonObject(traces),
            "redaction": redaction,
            "hook_config_hashes": [
                "codex": ProvenanceID.hash(HookConfig.codexConfig(command: "/fixture/bin/lineage-capture")),
                "github_copilot": ProvenanceID.hash(HookConfig.githubCopilotCLIConfig(command: "/fixture/bin/lineage-capture"))
            ],
            "counts": [
                "events": events.count,
                "sessions": sessions.count,
                "graph_nodes": graph.nodes.count,
                "graph_edges": graph.edges.count,
                "transcript_messages": evidence.messages.count,
                "agent_traces": traces.count
            ]
        ], fixturePath: fixtureRoot.path)

        let outputDirectory = URL(fileURLWithPath: outputEnvironment, isDirectory: true)
        try FileManager.default.createDirectory(at: outputDirectory, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: oracle, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: outputDirectory.appendingPathComponent("normalized.json"), options: [.atomic])
    }

    private var repositoryRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private var fixtureRoot: URL {
        repositoryRoot.appendingPathComponent("tests/fixtures/compatibility", isDirectory: true)
    }

    private var transcriptFixtureURL: URL {
        fixtureRoot.appendingPathComponent("transcripts/codex-session.jsonl")
    }

    private func materializeFixtureRepository() throws -> URL {
        let destination = FileManager.default.temporaryDirectory
            .appendingPathComponent("LineageCompatibility-\(UUID().uuidString)", isDirectory: true)
        let provenance = destination.appendingPathComponent(".lineage/provenance", isDirectory: true)
        let sessions = provenance.appendingPathComponent("sessions", isDirectory: true)
        try FileManager.default.createDirectory(at: sessions, withIntermediateDirectories: true)
        try FileManager.default.copyItem(
            at: fixtureRoot.appendingPathComponent("legacy/events.jsonl"),
            to: provenance.appendingPathComponent("events.jsonl")
        )
        try FileManager.default.copyItem(
            at: fixtureRoot.appendingPathComponent("legacy/sessions/codex-legacy-session.json"),
            to: sessions.appendingPathComponent("codex-stored-legacy-session.json")
        )
        return destination
    }

    private func redactionCases() throws -> [RedactionCase] {
        let data = try Data(contentsOf: fixtureRoot.appendingPathComponent("redaction/cases.json"))
        return try JSONDecoder().decode([RedactionCase].self, from: data)
    }

    private func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try JSONSerialization.jsonObject(with: encoder.encode(value))
    }

    private func normalize(_ value: Any, fixturePath: String) -> Any {
        switch value {
        case let object as [String: Any]:
            return object.mapValues { normalize($0, fixturePath: fixturePath) }
        case let array as [Any]:
            return array.map { normalize($0, fixturePath: fixturePath) }
        case let string as String:
            let stablePath = string
                .replacingOccurrences(of: "file://\(fixturePath)", with: "file:///fixture")
                .replacingOccurrences(of: fixturePath, with: "/fixture")
            if stablePath.range(
                of: #"^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-5][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$"#,
                options: .regularExpression
            ) != nil {
                return "<generated-uuid>"
            }
            return stablePath
        default:
            return value
        }
    }
}

private struct RedactionCase: Codable {
    var id: String
    var input: String
    var expected: String
}
