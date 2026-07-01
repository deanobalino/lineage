import Foundation

public struct AgentTraceRecord: Codable, Hashable, Identifiable {
    public var version: String
    public var id: String
    public var timestamp: Date
    public var vcs: AgentTraceVCS?
    public var tool: AgentTraceTool?
    public var files: [AgentTraceFile]
    public var metadata: [String: JSONValue]?

    public init(version: String = "0.1.0", id: String, timestamp: Date, vcs: AgentTraceVCS?, tool: AgentTraceTool?, files: [AgentTraceFile], metadata: [String: JSONValue]? = nil) {
        self.version = version
        self.id = id
        self.timestamp = timestamp
        self.vcs = vcs
        self.tool = tool
        self.files = files
        self.metadata = metadata
    }
}

public struct AgentTraceVCS: Codable, Hashable {
    public var type: String
    public var revision: String
}

public struct AgentTraceTool: Codable, Hashable {
    public var name: String
    public var version: String?
}

public struct AgentTraceFile: Codable, Hashable {
    public var path: String
    public var conversations: [AgentTraceConversation]
}

public struct AgentTraceConversation: Codable, Hashable {
    public var url: String?
    public var contributor: AgentTraceContributor
    public var ranges: [AgentTraceRange]
    public var related: [AgentTraceRelated]?
}

public struct AgentTraceContributor: Codable, Hashable {
    public var type: String
    public var modelID: String?

    enum CodingKeys: String, CodingKey {
        case type
        case modelID = "model_id"
    }
}

public struct AgentTraceRange: Codable, Hashable {
    public var startLine: Int
    public var endLine: Int
    public var contentHash: String?

    enum CodingKeys: String, CodingKey {
        case startLine = "start_line"
        case endLine = "end_line"
        case contentHash = "content_hash"
    }
}

public struct AgentTraceRelated: Codable, Hashable {
    public var type: String
    public var url: String
}

public struct AgentTraceExporter {
    public init() {}

    public func records(repoRoot: URL, sessions: [ProvenanceSession]) -> [AgentTraceRecord] {
        let graph = ProvenanceGraphBuilder().build(repoRoot: repoRoot, sessions: sessions)
        return sessions.compactMap { record(repoRoot: repoRoot, session: $0, graph: graph) }
    }

    public func record(repoRoot: URL, session: ProvenanceSession, graph: ProvenanceGraph? = nil) -> AgentTraceRecord? {
        let rangesByFile = Dictionary(grouping: session.lineRanges) { $0.file }
        let files: [AgentTraceFile] = rangesByFile.keys.sorted().compactMap { file in
            guard let ranges = rangesByFile[file]?.filter({ $0.start > 0 && $0.end >= $0.start }), !ranges.isEmpty else { return nil }
            let traceRanges = ranges
                .sorted { lhs, rhs in
                    lhs.start == rhs.start ? lhs.end < rhs.end : lhs.start < rhs.start
                }
                .map { range in
                    AgentTraceRange(
                        startLine: range.start,
                        endLine: range.end,
                        contentHash: contentHash(repoRoot: repoRoot, file: file, start: range.start, end: range.end)
                    )
                }
            let conversation = AgentTraceConversation(
                url: conversationURL(for: session),
                contributor: AgentTraceContributor(type: "ai", modelID: session.model),
                ranges: traceRanges,
                related: relatedLinks(for: session)
            )
            return AgentTraceFile(path: file, conversations: [conversation])
        }
        guard !files.isEmpty else { return nil }

        let graphNodeCount = graph?.nodes.count ?? 0
        let metadata: [String: JSONValue] = [
            "dev.lineage": .object([
                "session_id": .string(session.sessionID),
                "provider": .string(session.provider),
                "provider_display_name": .string(session.providerDisplayName),
                "source": .string(session.source),
                "turn_id": session.turnID.map(JSONValue.string) ?? .null,
                "tests_result": .string(session.testsResult),
                "tools_used": .array(session.toolsUsed.map(JSONValue.string)),
                "files_edited": .array(session.filesEdited.map(JSONValue.string)),
                "graph_nodes": .number(Double(graphNodeCount)),
                "has_raw_telemetry_payload": .bool(session.rawTelemetryPayload != nil),
                "raw_payload_policy": .string("Provider-specific raw payloads remain in .lineage/provenance/events.jsonl and session JSON.")
            ])
        ]

        return AgentTraceRecord(
            id: stableTraceID(session: session),
            timestamp: Date(),
            vcs: session.commitSHA.map { AgentTraceVCS(type: "git", revision: $0) },
            tool: AgentTraceTool(name: session.provider, version: nil),
            files: files,
            metadata: metadata
        )
    }

    public func writeJSONL(repoRoot: URL, sessions: [ProvenanceSession]) throws -> URL {
        let directory = repoRoot.appendingPathComponent(".agent-trace", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let output = directory.appendingPathComponent("traces.jsonl")
        let records = records(repoRoot: repoRoot, sessions: sessions)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let data = try records
            .map { try encoder.encode($0) }
            .map { String(data: $0, encoding: .utf8) ?? "{}" }
            .joined(separator: "\n")
            .appending(records.isEmpty ? "" : "\n")
            .data(using: .utf8) ?? Data()
        try data.write(to: output, options: [.atomic])
        return output
    }

    public func jsonlData(records: [AgentTraceRecord]) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        let lines = try records.map { record -> String in
            let data = try encoder.encode(record)
            return String(data: data, encoding: .utf8) ?? "{}"
        }
        return Data(lines.joined(separator: "\n").utf8)
    }

    private func stableTraceID(session: ProvenanceSession) -> String {
        let hash = ProvenanceID.hash("\(session.provider)|\(session.sessionID)|\(session.commitSHA ?? "")")
        return "\(hash.prefix(8))-\(hash.dropFirst(8).prefix(4))-5\(hash.dropFirst(13).prefix(3))-8\(hash.dropFirst(17).prefix(3))-\(hash.dropFirst(20).prefix(12))"
    }

    private func conversationURL(for session: ProvenanceSession) -> String? {
        if let transcriptPath = session.transcriptPath {
            return URL(fileURLWithPath: transcriptPath).absoluteString
        }
        return "lineage://session/\(session.provider)/\(session.sessionID)"
    }

    private func relatedLinks(for session: ProvenanceSession) -> [AgentTraceRelated] {
        var links = [AgentTraceRelated(type: "session", url: "lineage://session/\(session.provider)/\(session.sessionID)")]
        if let transcriptPath = session.transcriptPath {
            links.append(AgentTraceRelated(type: "transcript", url: URL(fileURLWithPath: transcriptPath).absoluteString))
        }
        return links
    }

    private func contentHash(repoRoot: URL, file: String, start: Int, end: Int) -> String? {
        let url = repoRoot.appendingPathComponent(file)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let lines = text.components(separatedBy: .newlines)
        guard start > 0, start <= lines.count else { return nil }
        let upper = min(max(end, start), lines.count)
        return ProvenanceID.hash(lines[(start - 1)..<upper].joined(separator: "\n"))
    }
}
