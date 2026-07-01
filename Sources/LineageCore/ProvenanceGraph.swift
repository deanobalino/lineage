import CryptoKit
import Foundation

public struct ProvenanceGraph: Codable, Hashable {
    public var nodes: [ProvenanceNode]
    public var edges: [ProvenanceEdge]

    public init(nodes: [ProvenanceNode] = [], edges: [ProvenanceEdge] = []) {
        self.nodes = nodes
        self.edges = edges
    }

    public func nodes(kind: ProvenanceNodeKind) -> [ProvenanceNode] {
        nodes.filter { $0.kind == kind }
    }

    public func linkedCodeNodes(sessionID: String) -> [ProvenanceNode] {
        let sessionNodeID = ProvenanceID.session(sessionID)
        let codeIDs = Set(edges.compactMap { edge -> String? in
            edge.from == sessionNodeID && edge.kind == .touches ? edge.to : nil
        })
        return nodes.filter { codeIDs.contains($0.id) }.sorted { $0.stableSortKey < $1.stableSortKey }
    }

    public func linkedEvidenceNodes(file: String, line: Int) -> [ProvenanceNode] {
        let matchingCodeIDs = Set(nodes.compactMap { node -> String? in
            guard node.kind == .line || node.kind == .range || node.kind == .file else { return nil }
            guard node.filePath == file else { return nil }
            if let start = node.startLine, let end = node.endLine {
                return line >= start && line <= end ? node.id : nil
            }
            return node.kind == .file ? node.id : nil
        })
        let evidenceIDs = Set(edges.compactMap { edge -> String? in
            matchingCodeIDs.contains(edge.to) && edge.kind == .evidencedBy ? edge.from : nil
        })
        return nodes.filter { evidenceIDs.contains($0.id) }.sorted { $0.stableSortKey < $1.stableSortKey }
    }
}

public enum ProvenanceNodeKind: String, Codable, Hashable {
    case repository
    case commit
    case file
    case range
    case line
    case session
    case turn
    case prompt
    case tool
    case decision
    case constraint
    case test
    case finalMessage = "final_message"
}

public struct ProvenanceNode: Codable, Identifiable, Hashable {
    public var id: String
    public var kind: ProvenanceNodeKind
    public var label: String
    public var repoRoot: String?
    public var commitSHA: String?
    public var filePath: String?
    public var startLine: Int?
    public var endLine: Int?
    public var sessionID: String?
    public var turnID: String?
    public var contentHash: String?
    public var provider: String?
    public var eventType: String?
    public var metadata: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case label
        case repoRoot = "repo_root"
        case commitSHA = "commit_sha"
        case filePath = "file_path"
        case startLine = "start_line"
        case endLine = "end_line"
        case sessionID = "session_id"
        case turnID = "turn_id"
        case contentHash = "content_hash"
        case provider
        case eventType = "event_type"
        case metadata
    }

    public init(
        id: String,
        kind: ProvenanceNodeKind,
        label: String,
        repoRoot: String? = nil,
        commitSHA: String? = nil,
        filePath: String? = nil,
        startLine: Int? = nil,
        endLine: Int? = nil,
        sessionID: String? = nil,
        turnID: String? = nil,
        contentHash: String? = nil,
        provider: String? = nil,
        eventType: String? = nil,
        metadata: [String: JSONValue] = [:]
    ) {
        self.id = id
        self.kind = kind
        self.label = label
        self.repoRoot = repoRoot
        self.commitSHA = commitSHA
        self.filePath = filePath
        self.startLine = startLine
        self.endLine = endLine
        self.sessionID = sessionID
        self.turnID = turnID
        self.contentHash = contentHash
        self.provider = provider
        self.eventType = eventType
        self.metadata = metadata
    }

    public var stableSortKey: String {
        [
            kind.rawValue,
            repoRoot ?? "",
            commitSHA ?? "",
            filePath ?? "",
            startLine.map(String.init) ?? "",
            endLine.map(String.init) ?? "",
            sessionID ?? "",
            turnID ?? "",
            id
        ].joined(separator: "|")
    }
}

public enum ProvenanceEdgeKind: String, Codable, Hashable {
    case contains
    case touches
    case evidencedBy = "evidenced_by"
    case occurredIn = "occurred_in"
    case derivedFrom = "derived_from"
}

public struct ProvenanceEdge: Codable, Identifiable, Hashable {
    public var id: String
    public var from: String
    public var to: String
    public var kind: ProvenanceEdgeKind
    public var confidence: Double?
    public var metadata: [String: JSONValue]

    enum CodingKeys: String, CodingKey {
        case id
        case from
        case to
        case kind
        case confidence
        case metadata
    }

    public init(from: String, to: String, kind: ProvenanceEdgeKind, confidence: Double? = nil, metadata: [String: JSONValue] = [:]) {
        self.id = ProvenanceID.edge(from: from, to: to, kind: kind.rawValue)
        self.from = from
        self.to = to
        self.kind = kind
        self.confidence = confidence
        self.metadata = metadata
    }
}

public enum ProvenanceID {
    public static func repository(_ repoRoot: String) -> String {
        "repo:\(hash(repoRoot))"
    }

    public static func commit(repoRoot: String, sha: String) -> String {
        "commit:\(hash("\(repoRoot)|\(sha)"))"
    }

    public static func file(repoRoot: String, commitSHA: String?, path: String) -> String {
        "file:\(hash("\(repoRoot)|\(commitSHA ?? "working")|\(path)"))"
    }

    public static func range(repoRoot: String, commitSHA: String?, path: String, start: Int, end: Int) -> String {
        "range:\(hash("\(repoRoot)|\(commitSHA ?? "working")|\(path)|\(start)-\(end)"))"
    }

    public static func line(repoRoot: String, commitSHA: String?, path: String, line: Int, contentHash: String?) -> String {
        "line:\(hash("\(repoRoot)|\(commitSHA ?? "working")|\(path)|\(line)|\(contentHash ?? "")"))"
    }

    public static func session(_ sessionID: String) -> String {
        "session:\(hash(sessionID))"
    }

    public static func turn(sessionID: String, turnID: String) -> String {
        "turn:\(hash("\(sessionID)|\(turnID)"))"
    }

    public static func evidence(kind: ProvenanceNodeKind, sessionID: String, stableKey: String) -> String {
        "\(kind.rawValue):\(hash("\(sessionID)|\(stableKey)"))"
    }

    public static func edge(from: String, to: String, kind: String) -> String {
        "edge:\(hash("\(from)|\(kind)|\(to)"))"
    }

    public static func hash(_ value: String) -> String {
        let digest = SHA256.hash(data: Data(value.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }
}

public struct ProvenanceGraphBuilder {
    public init() {}

    public func build(repoRoot: URL, sessions: [ProvenanceSession], events: [LineageEvent] = []) -> ProvenanceGraph {
        var nodesByID: [String: ProvenanceNode] = [:]
        var edgesByID: [String: ProvenanceEdge] = [:]
        let repoPath = repoRoot.path
        let repoID = ProvenanceID.repository(repoPath)
        insert(ProvenanceNode(id: repoID, kind: .repository, label: repoRoot.lastPathComponent, repoRoot: repoPath), into: &nodesByID)

        let eventsBySession = Dictionary(grouping: events) { $0.sessionID }

        for session in sessions {
            let sessionID = ProvenanceID.session(session.sessionID)
            insert(ProvenanceNode(
                id: sessionID,
                kind: .session,
                label: "\(session.providerDisplayName) \(short(session.sessionID))",
                repoRoot: repoPath,
                commitSHA: session.commitSHA,
                sessionID: session.sessionID,
                turnID: session.turnID,
                provider: session.provider,
                metadata: [
                    "source": .string(session.source),
                    "actor": .string(session.actor),
                    "model": session.model.map(JSONValue.string) ?? .null,
                    "lineage.session_path": .string("\(session.provider)-\(session.sessionID).json")
                ]
            ), into: &nodesByID)
            insert(ProvenanceEdge(from: repoID, to: sessionID, kind: .contains), into: &edgesByID)

            if let commitSHA = session.commitSHA, !commitSHA.isEmpty {
                let commitID = ProvenanceID.commit(repoRoot: repoPath, sha: commitSHA)
                insert(ProvenanceNode(id: commitID, kind: .commit, label: short(commitSHA), repoRoot: repoPath, commitSHA: commitSHA, metadata: ["message": session.commitMessage.map(JSONValue.string) ?? .null]), into: &nodesByID)
                insert(ProvenanceEdge(from: repoID, to: commitID, kind: .contains), into: &edgesByID)
                insert(ProvenanceEdge(from: sessionID, to: commitID, kind: .touches), into: &edgesByID)
            }

            for file in Set(session.filesEdited + session.lineRanges.map(\.file)) {
                let fileID = ProvenanceID.file(repoRoot: repoPath, commitSHA: session.commitSHA, path: file)
                insert(ProvenanceNode(id: fileID, kind: .file, label: file, repoRoot: repoPath, commitSHA: session.commitSHA, filePath: file), into: &nodesByID)
                if let commitSHA = session.commitSHA, !commitSHA.isEmpty {
                    let commitID = ProvenanceID.commit(repoRoot: repoPath, sha: commitSHA)
                    insert(ProvenanceEdge(from: commitID, to: fileID, kind: .contains), into: &edgesByID)
                } else {
                    insert(ProvenanceEdge(from: repoID, to: fileID, kind: .contains), into: &edgesByID)
                }
                insert(ProvenanceEdge(from: sessionID, to: fileID, kind: .touches), into: &edgesByID)
            }

            for range in session.lineRanges {
                guard range.start > 0, range.end >= range.start else { continue }
                let fileID = ProvenanceID.file(repoRoot: repoPath, commitSHA: session.commitSHA, path: range.file)
                let rangeID = ProvenanceID.range(repoRoot: repoPath, commitSHA: session.commitSHA, path: range.file, start: range.start, end: range.end)
                let rangeHash = contentHash(repoRoot: repoRoot, file: range.file, start: range.start, end: range.end)
                insert(ProvenanceNode(
                    id: rangeID,
                    kind: .range,
                    label: "\(range.file):\(range.start)-\(range.end)",
                    repoRoot: repoPath,
                    commitSHA: session.commitSHA,
                    filePath: range.file,
                    startLine: range.start,
                    endLine: range.end,
                    contentHash: rangeHash,
                    metadata: ["label": .string(range.label)]
                ), into: &nodesByID)
                insert(ProvenanceEdge(from: fileID, to: rangeID, kind: .contains), into: &edgesByID)
                insert(ProvenanceEdge(from: sessionID, to: rangeID, kind: .touches, confidence: range.confidence), into: &edgesByID)
                insert(ProvenanceEdge(from: sessionID, to: rangeID, kind: .evidencedBy, confidence: range.confidence), into: &edgesByID)

                let lineLimit = min(range.end, range.start + 199)
                for line in range.start...lineLimit {
                    let lineHash = contentHash(repoRoot: repoRoot, file: range.file, start: line, end: line)
                    let lineID = ProvenanceID.line(repoRoot: repoPath, commitSHA: session.commitSHA, path: range.file, line: line, contentHash: lineHash)
                    insert(ProvenanceNode(id: lineID, kind: .line, label: "\(range.file):\(line)", repoRoot: repoPath, commitSHA: session.commitSHA, filePath: range.file, startLine: line, endLine: line, contentHash: lineHash), into: &nodesByID)
                    insert(ProvenanceEdge(from: rangeID, to: lineID, kind: .contains), into: &edgesByID)
                    insert(ProvenanceEdge(from: sessionID, to: lineID, kind: .touches, confidence: range.confidence), into: &edgesByID)
                    insert(ProvenanceEdge(from: sessionID, to: lineID, kind: .evidencedBy, confidence: range.confidence), into: &edgesByID)
                }
            }

            addEvidenceNodes(repoPath: repoPath, session: session, events: eventsBySession[session.sessionID] ?? [], sessionNodeID: sessionID, turnNodeID: turnNodeID(for: session), nodesByID: &nodesByID, edgesByID: &edgesByID)
        }

        return ProvenanceGraph(
            nodes: nodesByID.values.sorted { $0.stableSortKey < $1.stableSortKey },
            edges: edgesByID.values.sorted { $0.id < $1.id }
        )
    }

    private func addEvidenceNodes(repoPath: String, session: ProvenanceSession, events: [LineageEvent], sessionNodeID: String, turnNodeID: String?, nodesByID: inout [String: ProvenanceNode], edgesByID: inout [String: ProvenanceEdge]) {
        if let turnID = session.turnID {
            let id = ProvenanceID.turn(sessionID: session.sessionID, turnID: turnID)
            insert(ProvenanceNode(id: id, kind: .turn, label: "Turn \(short(turnID))", sessionID: session.sessionID, turnID: turnID, provider: session.provider), into: &nodesByID)
            insert(ProvenanceEdge(from: sessionNodeID, to: id, kind: .contains), into: &edgesByID)
        }

        if !session.prompt.isEmpty {
            addEvidence(repoPath: repoPath, kind: .prompt, label: "Prompt", text: session.prompt, session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
        if !session.lastAssistantMessage.isEmpty {
            addEvidence(repoPath: repoPath, kind: .finalMessage, label: "Final message", text: session.lastAssistantMessage, session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
        for (index, tool) in session.toolsUsed.enumerated() {
            addEvidence(repoPath: repoPath, kind: .tool, label: tool, text: tool, stableSuffix: "tool-\(index)", session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
        for (index, command) in session.commandsRun.enumerated() {
            addEvidence(repoPath: repoPath, kind: .tool, label: command, text: command, stableSuffix: "command-\(index)", session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
        for (index, test) in session.testsRun.enumerated() {
            addEvidence(repoPath: repoPath, kind: .test, label: test, text: "\(test)\nResult: \(session.testsResult)", stableSuffix: "test-\(index)", session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
        for decision in session.decisions {
            addEvidence(repoPath: repoPath, kind: .decision, label: decision.kind, text: decision.context, stableSuffix: decision.id, session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
        for constraint in session.externalConstraints {
            addEvidence(repoPath: repoPath, kind: .constraint, label: constraint.locationLabel, text: constraint.summary, stableSuffix: constraint.id, session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }

        for event in events {
            guard event.eventType == CanonicalEventType.prompt || event.eventType == CanonicalEventType.preToolUse || event.eventType == CanonicalEventType.postToolUse else { continue }
            let key = event.id
            let label = event.payload.toolName ?? event.providerEventName
            addEvidence(repoPath: repoPath, kind: event.eventType == CanonicalEventType.prompt ? .prompt : .tool, label: label, text: event.providerEventName, stableSuffix: key, session: session, parentNodeID: turnNodeID ?? sessionNodeID, nodesByID: &nodesByID, edgesByID: &edgesByID)
        }
    }

    private func addEvidence(repoPath: String, kind: ProvenanceNodeKind, label: String, text: String, stableSuffix: String? = nil, session: ProvenanceSession, parentNodeID: String, nodesByID: inout [String: ProvenanceNode], edgesByID: inout [String: ProvenanceEdge]) {
        let stableKey = stableSuffix ?? "\(kind.rawValue)-\(ProvenanceID.hash(text))"
        let nodeID = ProvenanceID.evidence(kind: kind, sessionID: session.sessionID, stableKey: stableKey)
        insert(ProvenanceNode(
            id: nodeID,
            kind: kind,
            label: label,
            sessionID: session.sessionID,
            turnID: session.turnID,
            contentHash: ProvenanceID.hash(text),
            provider: session.provider,
            eventType: kind.rawValue,
            metadata: ["preview": .string(String(text.prefix(500)))]
        ), into: &nodesByID)
        insert(ProvenanceEdge(from: parentNodeID, to: nodeID, kind: .contains), into: &edgesByID)
        for range in session.lineRanges {
            guard range.start > 0, range.end >= range.start else { continue }
            let rangeID = ProvenanceID.range(repoRoot: repoPath, commitSHA: session.commitSHA, path: range.file, start: range.start, end: range.end)
            insert(ProvenanceEdge(from: nodeID, to: rangeID, kind: .evidencedBy, confidence: range.confidence), into: &edgesByID)
        }
    }

    private func insert(_ node: ProvenanceNode, into nodes: inout [String: ProvenanceNode]) {
        nodes[node.id] = node
    }

    private func insert(_ edge: ProvenanceEdge, into edges: inout [String: ProvenanceEdge]) {
        edges[edge.id] = edge
    }

    private func turnNodeID(for session: ProvenanceSession) -> String? {
        guard let turnID = session.turnID else { return nil }
        return ProvenanceID.turn(sessionID: session.sessionID, turnID: turnID)
    }

    private func contentHash(repoRoot: URL, file: String, start: Int, end: Int) -> String? {
        let url = repoRoot.appendingPathComponent(file)
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        let lines = text.components(separatedBy: .newlines)
        guard start > 0, start <= lines.count else { return nil }
        let upper = min(max(end, start), lines.count)
        return ProvenanceID.hash(lines[(start - 1)..<upper].joined(separator: "\n"))
    }

    private func short(_ value: String) -> String {
        value.count > 12 ? String(value.prefix(12)) : value
    }
}
