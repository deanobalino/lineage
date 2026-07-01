import Foundation

public struct SessionTelemetryEnvelope: Codable, Hashable, Identifiable {
    public var id: String { sessionID }
    public var provider: String
    public var sessionID: String
    public var turnID: String?
    public var source: String
    public var actor: String
    public var human: String?
    public var model: String?
    public var permissionMode: String?
    public var transcriptPath: String?
    public var prompt: String?
    public var events: [SessionTelemetryEvent]
    public var filesEdited: [String]
    public var lineRanges: [LineRange]
    public var commitSHA: String?
    public var commitMessage: String?
    public var rawPayload: JSONValue?

    enum CodingKeys: String, CodingKey {
        case provider
        case sessionID = "session_id"
        case turnID = "turn_id"
        case source
        case actor
        case human
        case model
        case permissionMode = "permission_mode"
        case transcriptPath = "transcript_path"
        case prompt
        case events
        case filesEdited = "files_edited"
        case lineRanges = "line_ranges"
        case commitSHA = "commit_sha"
        case commitMessage = "commit_message"
        case rawPayload = "raw_payload"
    }

    public init(
        provider: String,
        sessionID: String,
        turnID: String? = nil,
        source: String,
        actor: String,
        human: String? = nil,
        model: String? = nil,
        permissionMode: String? = nil,
        transcriptPath: String? = nil,
        prompt: String? = nil,
        events: [SessionTelemetryEvent] = [],
        filesEdited: [String] = [],
        lineRanges: [LineRange] = [],
        commitSHA: String? = nil,
        commitMessage: String? = nil,
        rawPayload: JSONValue? = nil
    ) {
        self.provider = provider
        self.sessionID = sessionID
        self.turnID = turnID
        self.source = source
        self.actor = actor
        self.human = human
        self.model = model
        self.permissionMode = permissionMode
        self.transcriptPath = transcriptPath
        self.prompt = prompt
        self.events = events
        self.filesEdited = filesEdited
        self.lineRanges = lineRanges
        self.commitSHA = commitSHA
        self.commitMessage = commitMessage
        self.rawPayload = rawPayload
    }

    public func provenanceSession() -> ProvenanceSession {
        let providerName = AIProvider.displayName(for: provider)
        let promptText = prompt ?? events.first { $0.kind == .prompt }?.body ?? ""
        let tools = Array(Set(events.compactMap { $0.kind == .tool ? $0.title : nil })).sorted()
        let commands = events.compactMap { $0.kind == .tool ? $0.command : nil }
        let tests = events.compactMap { $0.kind == .test ? ($0.command ?? $0.title) : nil }
        let testsResult = events.last { $0.kind == .test }?.result ?? "unknown"
        let decisions = events.filter { $0.kind == .decision }.map { event in
            DecisionRecord(
                kind: event.title,
                context: event.body,
                selectedOptionText: event.selectedOptionText,
                freeformResponse: event.freeformResponse,
                permissionStatus: event.permissionStatus,
                evidence: [source]
            )
        }
        let constraints = events.filter { $0.kind == .constraint }.map { event in
            ExternalConstraint(
                filePath: event.filePath ?? "Unknown",
                startLine: event.startLine,
                endLine: event.endLine,
                excerpt: event.excerpt,
                summary: event.body,
                source: source
            )
        }
        let finalMessage = events.last { $0.kind == .finalResponse }?.body ?? ""
        return ProvenanceSession(
            provider: provider,
            providerDisplayName: providerName,
            sessionID: sessionID,
            turnID: turnID,
            source: source,
            actor: actor,
            human: human,
            model: model,
            permissionMode: permissionMode,
            transcriptPath: transcriptPath,
            prompt: promptText,
            toolsUsed: tools,
            commandsRun: commands,
            filesEdited: filesEdited,
            testsRun: tests,
            testsResult: testsResult,
            permissionRequests: events.filter { $0.kind == .permission }.map(\.body),
            decisions: decisions,
            externalConstraints: constraints,
            lastAssistantMessage: finalMessage,
            gitDiff: "",
            commitSHA: commitSHA,
            commitMessage: commitMessage,
            reasoningSummary: "Imported from \(source) session telemetry. Lineage preserves the source payload as enrichment and keeps .lineage provenance storage as the source of truth.",
            lineRanges: lineRanges,
            rawTelemetryPayload: rawPayload
        )
    }
}

public struct SessionTelemetryEvent: Codable, Hashable, Identifiable {
    public var id: String
    public var kind: SessionTelemetryEventKind
    public var title: String
    public var body: String
    public var command: String?
    public var result: String?
    public var filePath: String?
    public var startLine: Int?
    public var endLine: Int?
    public var excerpt: String?
    public var selectedOptionText: String?
    public var freeformResponse: String?
    public var permissionStatus: String?
    public var rawPayload: JSONValue?

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case title
        case body
        case command
        case result
        case filePath = "file_path"
        case startLine = "start_line"
        case endLine = "end_line"
        case excerpt
        case selectedOptionText = "selected_option_text"
        case freeformResponse = "freeform_response"
        case permissionStatus = "permission_status"
        case rawPayload = "raw_payload"
    }

    public init(
        id: String = UUID().uuidString,
        kind: SessionTelemetryEventKind,
        title: String,
        body: String,
        command: String? = nil,
        result: String? = nil,
        filePath: String? = nil,
        startLine: Int? = nil,
        endLine: Int? = nil,
        excerpt: String? = nil,
        selectedOptionText: String? = nil,
        freeformResponse: String? = nil,
        permissionStatus: String? = nil,
        rawPayload: JSONValue? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.command = command
        self.result = result
        self.filePath = filePath
        self.startLine = startLine
        self.endLine = endLine
        self.excerpt = excerpt
        self.selectedOptionText = selectedOptionText
        self.freeformResponse = freeformResponse
        self.permissionStatus = permissionStatus
        self.rawPayload = rawPayload
    }
}

public enum SessionTelemetryEventKind: String, Codable, Hashable {
    case prompt
    case tool
    case decision
    case constraint
    case test
    case permission
    case finalResponse = "final_response"
}
