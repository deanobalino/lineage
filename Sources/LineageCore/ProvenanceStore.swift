import Foundation

public struct ProvenanceStore {
    public var repoRoot: URL
    private var decoder: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
    private var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    public init(repoRoot: URL) {
        self.repoRoot = repoRoot
    }

    public var provenanceDirectory: URL {
        repoRoot.appendingPathComponent(".lineage/provenance", isDirectory: true)
    }

    public var eventsFile: URL {
        provenanceDirectory.appendingPathComponent("events.jsonl")
    }

    public var sessionsDirectory: URL {
        provenanceDirectory.appendingPathComponent("sessions", isDirectory: true)
    }

    public func ensureDirectories() throws {
        try FileManager.default.createDirectory(at: sessionsDirectory, withIntermediateDirectories: true)
    }

    public func append(event: LineageEvent) throws {
        try ensureDirectories()
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        var data = try encoder.encode(event)
        data.append(0x0a)
        if FileManager.default.fileExists(atPath: eventsFile.path) {
            let handle = try FileHandle(forWritingTo: eventsFile)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } else {
            try data.write(to: eventsFile)
        }
    }

    public func events() -> [LineageEvent] {
        guard let data = try? Data(contentsOf: eventsFile),
              let text = String(data: data, encoding: .utf8) else { return [] }
        return text
            .split(separator: "\n")
            .compactMap { line in
                try? decoder.decode(LineageEvent.self, from: Data(line.utf8))
            }
    }

    public func sessions() -> [ProvenanceSession] {
        guard let urls = try? FileManager.default.contentsOfDirectory(at: sessionsDirectory, includingPropertiesForKeys: nil) else { return [] }
        return urls
            .filter { $0.pathExtension == "json" }
            .compactMap { url in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return try? decoder.decode(ProvenanceSession.self, from: data)
            }
            .sorted { $0.sessionID < $1.sessionID }
    }

    public func write(session: ProvenanceSession) throws {
        try ensureDirectories()
        let data = try encoder.encode(session)
        let filename = "\(session.provider)-\(session.sessionID).json"
        try data.write(to: sessionsDirectory.appendingPathComponent(filename))
    }

    public func matchingSession(file: String, line: Int, commitSHA: String? = nil) -> ProvenanceSession? {
        let allSessions = sessions()
        if let direct = allSessions.first(where: { session in
            session.lineRanges.contains { $0.contains(file: file, line: line) }
        }) {
            return direct
        }

        guard let commitSHA, !commitSHA.isEmpty, commitSHA != "Unknown" else {
            return nil
        }
        return allSessions.first { session in
            guard let sessionCommit = session.commitSHA, commitsMatch(sessionCommit, commitSHA) else { return false }
            return session.filesEdited.contains(file) || session.lineRanges.contains { $0.file == file }
        }
    }

    public func provenanceGraph() -> ProvenanceGraph {
        ProvenanceGraphBuilder().build(repoRoot: repoRoot, sessions: sessions(), events: events())
    }

    public func exportAgentTrace() throws -> URL {
        try AgentTraceExporter().writeJSONL(repoRoot: repoRoot, sessions: sessions())
    }

    private func commitsMatch(_ lhs: String, _ rhs: String) -> Bool {
        lhs == rhs || lhs.hasPrefix(rhs) || rhs.hasPrefix(lhs)
    }

    public func summary(files: [String]) -> ProvenanceSummary {
        let sessions = sessions()
        let events = events()
        let toolCalls = events.filter { $0.eventType == CanonicalEventType.preToolUse || $0.eventType == CanonicalEventType.postToolUse || $0.hookEventName == "PreToolUse" || $0.hookEventName == "PostToolUse" }.count
        let edited = Set(sessions.flatMap(\.filesEdited)).count
        let explainedFiles = Set(sessions.flatMap { $0.lineRanges.map(\.file) })
        let explainedPercent = files.isEmpty ? 0 : min(100, Int((Double(explainedFiles.count) / Double(max(files.count, 1))) * 100.0))
        let configured = FileManager.default.fileExists(atPath: repoRoot.appendingPathComponent(".codex/config.toml").path)
        let providers = Array(Set(sessions.map(\.providerDisplayName) + events.map { AIProvider.displayName(for: $0.provider) })).sorted()
        return ProvenanceSummary(
            configured: configured,
            providers: providers,
            sessionsCaptured: sessions.count,
            toolCalls: toolCalls,
            filesEdited: edited,
            explainedPercent: explainedPercent,
            eventsCaptured: events.count,
            lastSession: sessions.last?.sessionID ?? "None",
            lastEvent: events.last?.providerEventName ?? "None"
        )
    }
}
