import Foundation

public struct LineageEvent: Codable, Identifiable, Hashable {
    public var id: String
    public var lineageSchemaVersion: String
    public var capturedAt: Date
    public var source: String
    public var provider: String
    public var providerEventName: String
    public var eventType: String
    public var actor: String
    public var human: String?
    public var hookEventName: String
    public var sessionID: String
    public var turnID: String?
    public var cwd: String
    public var repoRoot: String
    public var model: String?
    public var permissionMode: String?
    public var transcriptPath: String?
    public var payload: EventPayload

    enum CodingKeys: String, CodingKey {
        case id
        case lineageSchemaVersion = "lineage_schema_version"
        case capturedAt = "captured_at"
        case source
        case provider
        case providerEventName = "provider_event_name"
        case eventType = "event_type"
        case actor
        case human
        case hookEventName = "hook_event_name"
        case sessionID = "session_id"
        case turnID = "turn_id"
        case cwd
        case repoRoot = "repo_root"
        case model
        case permissionMode = "permission_mode"
        case transcriptPath = "transcript_path"
        case payload
    }

    public init(
        id: String = UUID().uuidString,
        lineageSchemaVersion: String = "0.1",
        capturedAt: Date = Date(),
        source: String = "codex-hook",
        provider: String = AIProvider.codex.id,
        providerEventName: String? = nil,
        eventType: String? = nil,
        actor: String = AIProvider.codex.displayName,
        human: String? = nil,
        hookEventName: String,
        sessionID: String,
        turnID: String?,
        cwd: String,
        repoRoot: String,
        model: String?,
        permissionMode: String?,
        transcriptPath: String?,
        payload: EventPayload
    ) {
        self.id = id
        self.lineageSchemaVersion = lineageSchemaVersion
        self.capturedAt = capturedAt
        self.source = source
        self.provider = provider
        self.providerEventName = providerEventName ?? hookEventName
        self.eventType = eventType ?? CanonicalEventType.from(providerEventName: hookEventName)
        self.actor = actor
        self.human = human
        self.hookEventName = hookEventName
        self.sessionID = sessionID
        self.turnID = turnID
        self.cwd = cwd
        self.repoRoot = repoRoot
        self.model = model
        self.permissionMode = permissionMode
        self.transcriptPath = transcriptPath
        self.payload = payload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        lineageSchemaVersion = try container.decodeIfPresent(String.self, forKey: .lineageSchemaVersion) ?? "0.1"
        capturedAt = try container.decodeIfPresent(Date.self, forKey: .capturedAt) ?? Date()
        source = try container.decodeIfPresent(String.self, forKey: .source) ?? "codex-hook"
        hookEventName = try container.decodeIfPresent(String.self, forKey: .hookEventName)
            ?? container.decodeIfPresent(String.self, forKey: .providerEventName)
            ?? "Unknown"
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? AIProvider.codex.id
        providerEventName = try container.decodeIfPresent(String.self, forKey: .providerEventName) ?? hookEventName
        eventType = try container.decodeIfPresent(String.self, forKey: .eventType) ?? CanonicalEventType.from(providerEventName: providerEventName)
        actor = try container.decodeIfPresent(String.self, forKey: .actor) ?? AIProvider.displayName(for: provider)
        human = try container.decodeIfPresent(String.self, forKey: .human)
        sessionID = try container.decode(String.self, forKey: .sessionID)
        turnID = try container.decodeIfPresent(String.self, forKey: .turnID)
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        repoRoot = try container.decodeIfPresent(String.self, forKey: .repoRoot) ?? cwd
        model = try container.decodeIfPresent(String.self, forKey: .model)
        permissionMode = try container.decodeIfPresent(String.self, forKey: .permissionMode)
        transcriptPath = try container.decodeIfPresent(String.self, forKey: .transcriptPath)
        payload = try container.decodeIfPresent(EventPayload.self, forKey: .payload) ?? EventPayload()
    }
}

public struct AIProvider: Codable, Hashable, Identifiable {
    public var id: String
    public var displayName: String

    public static let codex = AIProvider(id: "codex", displayName: "Codex")
    public static let claudeCode = AIProvider(id: "claude-code", displayName: "Claude Code")
    public static let githubCopilot = AIProvider(id: "github-copilot", displayName: "GitHub Copilot")
    public static let cursor = AIProvider(id: "cursor", displayName: "Cursor")

    public static func displayName(for id: String) -> String {
        switch id {
        case codex.id: return codex.displayName
        case claudeCode.id: return claudeCode.displayName
        case githubCopilot.id: return githubCopilot.displayName
        case cursor.id: return cursor.displayName
        default:
            return id
                .split(separator: "-")
                .map { $0.capitalized }
                .joined(separator: " ")
        }
    }
}

public enum CanonicalEventType {
    public static let sessionStart = "session_start"
    public static let prompt = "prompt"
    public static let preToolUse = "pre_tool_use"
    public static let postToolUse = "post_tool_use"
    public static let permissionRequest = "permission_request"
    public static let assistantOptionsPresented = "assistant_options_presented"
    public static let userDecision = "user_decision"
    public static let permissionDecision = "permission_decision"
    public static let externalConstraint = "external_constraint"
    public static let sessionStop = "session_stop"
    public static let unknown = "unknown"

    public static func from(providerEventName: String) -> String {
        switch providerEventName {
        case "SessionStart": return sessionStart
        case "UserPromptSubmit": return prompt
        case "PreToolUse": return preToolUse
        case "PostToolUse": return postToolUse
        case "PermissionRequest": return permissionRequest
        case "AssistantOptionsPresented": return assistantOptionsPresented
        case "UserDecision": return userDecision
        case "PermissionDecision": return permissionDecision
        case "ExternalConstraint": return externalConstraint
        case "Stop": return sessionStop
        default: return providerEventName.isEmpty ? unknown : providerEventName
        }
    }
}

public struct EventPayload: Codable, Hashable {
    public var prompt: String?
    public var toolName: String?
    public var toolUseID: String?
    public var toolInput: JSONValue?
    public var toolResponse: JSONValue?
    public var approvalReason: String?
    public var approvalStatus: String?
    public var lastAssistantMessage: String?
    public var gitStatus: String?
    public var gitDiff: String?
    public var gitHead: String?
    public var changedFiles: [String]?
    public var testsDetected: [String]?
    public var testsResult: String?
    public var optionsPresented: [DecisionOption]?
    public var selectedOptionText: String?
    public var freeformResponse: String?
    public var decisionContext: String?
    public var decisionConsequences: String?
    public var externalConstraints: [ExternalConstraint]?
    public var rawProviderPayload: JSONValue?

    enum CodingKeys: String, CodingKey {
        case prompt
        case toolName = "tool_name"
        case toolUseID = "tool_use_id"
        case toolInput = "tool_input"
        case toolResponse = "tool_response"
        case approvalReason = "approval_reason"
        case approvalStatus = "approval_status"
        case lastAssistantMessage = "last_assistant_message"
        case gitStatus = "git_status"
        case gitDiff = "git_diff"
        case gitHead = "git_head"
        case changedFiles = "changed_files"
        case testsDetected = "tests_detected"
        case testsResult = "tests_result"
        case optionsPresented = "options_presented"
        case selectedOptionText = "selected_option_text"
        case freeformResponse = "freeform_response"
        case decisionContext = "decision_context"
        case decisionConsequences = "decision_consequences"
        case externalConstraints = "external_constraints"
        case rawProviderPayload = "raw_provider_payload"
    }

    public init(
        prompt: String? = nil,
        toolName: String? = nil,
        toolUseID: String? = nil,
        toolInput: JSONValue? = nil,
        toolResponse: JSONValue? = nil,
        approvalReason: String? = nil,
        approvalStatus: String? = nil,
        lastAssistantMessage: String? = nil,
        gitStatus: String? = nil,
        gitDiff: String? = nil,
        gitHead: String? = nil,
        changedFiles: [String]? = nil,
        testsDetected: [String]? = nil,
        testsResult: String? = nil,
        optionsPresented: [DecisionOption]? = nil,
        selectedOptionText: String? = nil,
        freeformResponse: String? = nil,
        decisionContext: String? = nil,
        decisionConsequences: String? = nil,
        externalConstraints: [ExternalConstraint]? = nil,
        rawProviderPayload: JSONValue? = nil
    ) {
        self.prompt = prompt
        self.toolName = toolName
        self.toolUseID = toolUseID
        self.toolInput = toolInput
        self.toolResponse = toolResponse
        self.approvalReason = approvalReason
        self.approvalStatus = approvalStatus
        self.lastAssistantMessage = lastAssistantMessage
        self.gitStatus = gitStatus
        self.gitDiff = gitDiff
        self.gitHead = gitHead
        self.changedFiles = changedFiles
        self.testsDetected = testsDetected
        self.testsResult = testsResult
        self.optionsPresented = optionsPresented
        self.selectedOptionText = selectedOptionText
        self.freeformResponse = freeformResponse
        self.decisionContext = decisionContext
        self.decisionConsequences = decisionConsequences
        self.externalConstraints = externalConstraints
        self.rawProviderPayload = rawProviderPayload
    }
}

public struct DecisionOption: Codable, Hashable, Identifiable {
    public var id: String
    public var text: String
    public var rationale: String?

    enum CodingKeys: String, CodingKey {
        case id
        case text
        case rationale
    }

    public init(id: String = UUID().uuidString, text: String, rationale: String? = nil) {
        self.id = id
        self.text = text
        self.rationale = rationale
    }
}

public struct ExternalConstraint: Codable, Hashable, Identifiable {
    public var id: String
    public var filePath: String
    public var startLine: Int?
    public var endLine: Int?
    public var excerpt: String?
    public var summary: String
    public var source: String

    enum CodingKeys: String, CodingKey {
        case id
        case filePath = "file_path"
        case startLine = "start_line"
        case endLine = "end_line"
        case excerpt
        case summary
        case source
    }

    public init(id: String = UUID().uuidString, filePath: String, startLine: Int? = nil, endLine: Int? = nil, excerpt: String? = nil, summary: String, source: String) {
        self.id = id
        self.filePath = filePath
        self.startLine = startLine
        self.endLine = endLine
        self.excerpt = excerpt
        self.summary = summary
        self.source = source
    }

    public var locationLabel: String {
        if let startLine, let endLine {
            return "\(filePath):\(startLine)-\(endLine)"
        }
        if let startLine {
            return "\(filePath):\(startLine)"
        }
        return filePath
    }
}

public struct DecisionRecord: Codable, Hashable, Identifiable {
    public var id: String
    public var kind: String
    public var context: String
    public var selectedOptionText: String?
    public var freeformResponse: String?
    public var alternatives: [DecisionOption]
    public var permissionStatus: String?
    public var evidence: [String]
    public var consequences: String?

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case context
        case selectedOptionText = "selected_option_text"
        case freeformResponse = "freeform_response"
        case alternatives
        case permissionStatus = "permission_status"
        case evidence
        case consequences
    }

    public init(id: String = UUID().uuidString, kind: String, context: String, selectedOptionText: String? = nil, freeformResponse: String? = nil, alternatives: [DecisionOption] = [], permissionStatus: String? = nil, evidence: [String] = [], consequences: String? = nil) {
        self.id = id
        self.kind = kind
        self.context = context
        self.selectedOptionText = selectedOptionText
        self.freeformResponse = freeformResponse
        self.alternatives = alternatives
        self.permissionStatus = permissionStatus
        self.evidence = evidence
        self.consequences = consequences
    }
}

public enum JSONValue: Codable, Hashable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value):
            try container.encode(value)
        case .number(let value):
            try container.encode(value)
        case .bool(let value):
            try container.encode(value)
        case .object(let value):
            try container.encode(value)
        case .array(let value):
            try container.encode(value)
        case .null:
            try container.encodeNil()
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }

    public static func fromAny(_ value: Any?) -> JSONValue {
        switch value {
        case let value as String:
            return .string(value)
        case let value as Int:
            return .number(Double(value))
        case let value as Double:
            return .number(value)
        case let value as Bool:
            return .bool(value)
        case let value as [Any]:
            return .array(value.map(JSONValue.fromAny))
        case let value as [String: Any]:
            return .object(value.mapValues(JSONValue.fromAny))
        default:
            return .null
        }
    }
}

public struct ProvenanceSession: Codable, Identifiable, Hashable {
    public var id: String { sessionID }
    public var provider: String
    public var providerDisplayName: String
    public var sessionID: String
    public var turnID: String?
    public var source: String
    public var actor: String
    public var human: String?
    public var model: String?
    public var permissionMode: String?
    public var transcriptPath: String?
    public var humanReviewer: String
    public var prompt: String
    public var toolsUsed: [String]
    public var commandsRun: [String]
    public var filesEdited: [String]
    public var testsRun: [String]
    public var testsResult: String
    public var permissionRequests: [String]
    public var decisions: [DecisionRecord]
    public var externalConstraints: [ExternalConstraint]
    public var lastAssistantMessage: String
    public var gitDiff: String
    public var commitSHA: String?
    public var commitMessage: String?
    public var reasoningSummary: String
    public var lineRanges: [LineRange]
    public var rawTelemetryPayload: JSONValue?

    enum CodingKeys: String, CodingKey {
        case provider
        case providerDisplayName = "provider_display_name"
        case sessionID = "session_id"
        case turnID = "turn_id"
        case source
        case actor
        case human
        case model
        case permissionMode = "permission_mode"
        case transcriptPath = "transcript_path"
        case humanReviewer = "human_reviewer"
        case prompt
        case toolsUsed = "tools_used"
        case commandsRun = "commands_run"
        case filesEdited = "files_edited"
        case testsRun = "tests_run"
        case testsResult = "tests_result"
        case permissionRequests = "permission_requests"
        case decisions
        case externalConstraints = "external_constraints"
        case lastAssistantMessage = "last_assistant_message"
        case gitDiff = "git_diff"
        case commitSHA = "commit_sha"
        case commitMessage = "commit_message"
        case reasoningSummary = "reasoning_summary"
        case lineRanges = "line_ranges"
        case rawTelemetryPayload = "raw_telemetry_payload"
    }

    public init(
        provider: String = AIProvider.codex.id,
        providerDisplayName: String = AIProvider.codex.displayName,
        sessionID: String,
        turnID: String?,
        source: String = "codex",
        actor: String = "Codex",
        human: String? = nil,
        model: String?,
        permissionMode: String? = nil,
        transcriptPath: String? = nil,
        humanReviewer: String = "Unknown",
        prompt: String,
        toolsUsed: [String],
        commandsRun: [String],
        filesEdited: [String],
        testsRun: [String],
        testsResult: String,
        permissionRequests: [String],
        decisions: [DecisionRecord] = [],
        externalConstraints: [ExternalConstraint] = [],
        lastAssistantMessage: String,
        gitDiff: String,
        commitSHA: String?,
        commitMessage: String?,
        reasoningSummary: String,
        lineRanges: [LineRange],
        rawTelemetryPayload: JSONValue? = nil
    ) {
        self.provider = provider
        self.providerDisplayName = providerDisplayName
        self.sessionID = sessionID
        self.turnID = turnID
        self.source = source
        self.actor = actor
        self.human = human
        self.model = model
        self.permissionMode = permissionMode
        self.transcriptPath = transcriptPath
        self.humanReviewer = humanReviewer
        self.prompt = prompt
        self.toolsUsed = toolsUsed
        self.commandsRun = commandsRun
        self.filesEdited = filesEdited
        self.testsRun = testsRun
        self.testsResult = testsResult
        self.permissionRequests = permissionRequests
        self.decisions = decisions
        self.externalConstraints = externalConstraints
        self.lastAssistantMessage = lastAssistantMessage
        self.gitDiff = gitDiff
        self.commitSHA = commitSHA
        self.commitMessage = commitMessage
        self.reasoningSummary = reasoningSummary
        self.lineRanges = lineRanges
        self.rawTelemetryPayload = rawTelemetryPayload
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decodeIfPresent(String.self, forKey: .provider) ?? AIProvider.codex.id
        providerDisplayName = try container.decodeIfPresent(String.self, forKey: .providerDisplayName) ?? AIProvider.displayName(for: provider)
        sessionID = try container.decode(String.self, forKey: .sessionID)
        turnID = try container.decodeIfPresent(String.self, forKey: .turnID)
        source = try container.decodeIfPresent(String.self, forKey: .source) ?? provider
        actor = try container.decodeIfPresent(String.self, forKey: .actor) ?? providerDisplayName
        human = try container.decodeIfPresent(String.self, forKey: .human)
        model = try container.decodeIfPresent(String.self, forKey: .model)
        permissionMode = try container.decodeIfPresent(String.self, forKey: .permissionMode)
        transcriptPath = try container.decodeIfPresent(String.self, forKey: .transcriptPath)
        humanReviewer = try container.decodeIfPresent(String.self, forKey: .humanReviewer) ?? "Unknown"
        prompt = try container.decodeIfPresent(String.self, forKey: .prompt) ?? ""
        toolsUsed = try container.decodeIfPresent([String].self, forKey: .toolsUsed) ?? []
        commandsRun = try container.decodeIfPresent([String].self, forKey: .commandsRun) ?? []
        filesEdited = try container.decodeIfPresent([String].self, forKey: .filesEdited) ?? []
        testsRun = try container.decodeIfPresent([String].self, forKey: .testsRun) ?? []
        testsResult = try container.decodeIfPresent(String.self, forKey: .testsResult) ?? "unknown"
        permissionRequests = try container.decodeIfPresent([String].self, forKey: .permissionRequests) ?? []
        decisions = try container.decodeIfPresent([DecisionRecord].self, forKey: .decisions) ?? []
        externalConstraints = try container.decodeIfPresent([ExternalConstraint].self, forKey: .externalConstraints) ?? []
        lastAssistantMessage = try container.decodeIfPresent(String.self, forKey: .lastAssistantMessage) ?? ""
        gitDiff = try container.decodeIfPresent(String.self, forKey: .gitDiff) ?? ""
        commitSHA = try container.decodeIfPresent(String.self, forKey: .commitSHA)
        commitMessage = try container.decodeIfPresent(String.self, forKey: .commitMessage)
        reasoningSummary = try container.decodeIfPresent(String.self, forKey: .reasoningSummary) ?? ""
        lineRanges = try container.decodeIfPresent([LineRange].self, forKey: .lineRanges) ?? []
        rawTelemetryPayload = try container.decodeIfPresent(JSONValue.self, forKey: .rawTelemetryPayload)
    }
}

public struct LineRange: Codable, Hashable, Identifiable {
    public var id: String { "\(file):\(start)-\(end)" }
    public var file: String
    public var start: Int
    public var end: Int
    public var confidence: Double
    public var label: String

    public init(file: String, start: Int, end: Int, confidence: Double, label: String) {
        self.file = file
        self.start = start
        self.end = end
        self.confidence = confidence
        self.label = label
    }

    public func contains(file candidate: String, line: Int) -> Bool {
        file == candidate && line >= start && line <= end
    }
}

public struct RepositorySnapshot: Hashable {
    public var root: URL
    public var name: String
    public var branch: String
    public var branches: [String]
    public var latestCommit: String
    public var files: [RepoFile]
    public var provenanceSummary: ProvenanceSummary

    public init(root: URL, name: String, branch: String, branches: [String], latestCommit: String, files: [RepoFile], provenanceSummary: ProvenanceSummary) {
        self.root = root
        self.name = name
        self.branch = branch
        self.branches = branches
        self.latestCommit = latestCommit
        self.files = files
        self.provenanceSummary = provenanceSummary
    }
}

public struct RepoFile: Identifiable, Hashable {
    public var id: String { path }
    public var path: String
    public var name: String
    public var provenanceProviders: [String]

    public init(path: String, provenanceProviders: [String] = []) {
        self.path = path
        self.name = URL(fileURLWithPath: path).lastPathComponent
        self.provenanceProviders = provenanceProviders
    }
}

public struct ProvenanceSummary: Hashable {
    public var configured: Bool
    public var providers: [String]
    public var sessionsCaptured: Int
    public var toolCalls: Int
    public var filesEdited: Int
    public var explainedPercent: Int
    public var eventsCaptured: Int
    public var lastSession: String
    public var lastEvent: String

    public init(configured: Bool, providers: [String], sessionsCaptured: Int, toolCalls: Int, filesEdited: Int, explainedPercent: Int, eventsCaptured: Int, lastSession: String, lastEvent: String) {
        self.configured = configured
        self.providers = providers
        self.sessionsCaptured = sessionsCaptured
        self.toolCalls = toolCalls
        self.filesEdited = filesEdited
        self.explainedPercent = explainedPercent
        self.eventsCaptured = eventsCaptured
        self.lastSession = lastSession
        self.lastEvent = lastEvent
    }
}

public struct ReviewSnapshot: Hashable {
    public var baseBranch: String
    public var headBranch: String
    public var mergeBase: String
    public var changedFiles: [ReviewChangedFile]
    public var commits: [ReviewCommit]
    public var summary: ReviewSummary

    public init(baseBranch: String, headBranch: String, mergeBase: String, changedFiles: [ReviewChangedFile], commits: [ReviewCommit], summary: ReviewSummary) {
        self.baseBranch = baseBranch
        self.headBranch = headBranch
        self.mergeBase = mergeBase
        self.changedFiles = changedFiles
        self.commits = commits
        self.summary = summary
    }
}

public struct ReviewSummary: Hashable {
    public var filesChanged: Int
    public var commitsOnBranch: Int
    public var providerSessionsLinked: Int
    public var filesWithRecordedProvenance: Int
    public var filesInferredFromGitOnly: Int

    public init(filesChanged: Int, commitsOnBranch: Int, providerSessionsLinked: Int, filesWithRecordedProvenance: Int, filesInferredFromGitOnly: Int) {
        self.filesChanged = filesChanged
        self.commitsOnBranch = commitsOnBranch
        self.providerSessionsLinked = providerSessionsLinked
        self.filesWithRecordedProvenance = filesWithRecordedProvenance
        self.filesInferredFromGitOnly = filesInferredFromGitOnly
    }
}

public struct ReviewChangedFile: Identifiable, Hashable {
    public var id: String { path }
    public var status: String
    public var path: String
    public var oldPath: String?
    public var providerSessions: [ProvenanceSession]

    public init(status: String, path: String, oldPath: String? = nil, providerSessions: [ProvenanceSession] = []) {
        self.status = status
        self.path = path
        self.oldPath = oldPath
        self.providerSessions = providerSessions
    }

    public var statusLabel: String {
        switch status.prefix(1) {
        case "A": return "Added"
        case "M": return "Modified"
        case "D": return "Deleted"
        case "R": return "Renamed"
        default: return status
        }
    }
}

public struct ReviewCommit: Identifiable, Hashable {
    public var id: String { sha }
    public var sha: String
    public var summary: String

    public init(sha: String, summary: String) {
        self.sha = sha
        self.summary = summary
    }
}

public struct FileDiff: Hashable {
    public var file: ReviewChangedFile
    public var hunks: [DiffHunk]

    public init(file: ReviewChangedFile, hunks: [DiffHunk]) {
        self.file = file
        self.hunks = hunks
    }

    public var lines: [DiffLine] {
        hunks.flatMap(\.lines)
    }
}

public struct DiffHunk: Identifiable, Hashable {
    public var id: String
    public var header: String
    public var oldStart: Int
    public var newStart: Int
    public var lines: [DiffLine]

    public init(id: String = UUID().uuidString, header: String, oldStart: Int, newStart: Int, lines: [DiffLine]) {
        self.id = id
        self.header = header
        self.oldStart = oldStart
        self.newStart = newStart
        self.lines = lines
    }
}

public struct DiffLine: Identifiable, Hashable {
    public var id: String
    public var kind: String
    public var oldLine: Int?
    public var newLine: Int?
    public var text: String
    public var commitSHA: String?
    public var commitSummary: String?
    public var badge: String?
    public var confidence: Double?

    public init(id: String = UUID().uuidString, kind: String, oldLine: Int?, newLine: Int?, text: String, commitSHA: String? = nil, commitSummary: String? = nil, badge: String? = nil, confidence: Double? = nil) {
        self.id = id
        self.kind = kind
        self.oldLine = oldLine
        self.newLine = newLine
        self.text = text
        self.commitSHA = commitSHA
        self.commitSummary = commitSummary
        self.badge = badge
        self.confidence = confidence
    }
}

public struct ReviewChangeExplanation: Hashable {
    public var answer: String
    public var confidenceLabel: String
    public var providerSessions: [ProvenanceSession]
    public var evidence: [EvidenceCard]
    public var gitSummary: String

    public init(answer: String, confidenceLabel: String, providerSessions: [ProvenanceSession], evidence: [EvidenceCard], gitSummary: String) {
        self.answer = answer
        self.confidenceLabel = confidenceLabel
        self.providerSessions = providerSessions
        self.evidence = evidence
        self.gitSummary = gitSummary
    }
}

public struct CodeLine: Identifiable, Hashable {
    public var id: Int { number }
    public var number: Int
    public var text: String
    public var badge: String?
    public var confidence: Double?
    public var commitSHA: String?
    public var commitSummary: String?

    public init(number: Int, text: String, badge: String?, confidence: Double?, commitSHA: String? = nil, commitSummary: String? = nil) {
        self.number = number
        self.text = text
        self.badge = badge
        self.confidence = confidence
        self.commitSHA = commitSHA
        self.commitSummary = commitSummary
    }
}

public struct GitLineIdentity: Hashable {
    public var commitSHA: String
    public var summary: String

    public init(commitSHA: String, summary: String) {
        self.commitSHA = commitSHA
        self.summary = summary
    }

    public var shortSHA: String {
        String(commitSHA.prefix(7))
    }
}

public struct LineExplanation: Hashable {
    public var answer: String
    public var confidence: Double
    public var confidenceLabel: String
    public var originActor: String
    public var originReviewer: String
    public var gitEvidence: GitLineEvidence
    public var decisionProvenance: DecisionProvenance
    public var architectureDecision: ArchitectureDecision?
    public var providerSession: ProvenanceSession?
    public var timeline: [String]
    public var evidence: [EvidenceCard]
    public var couldRemove: RemovalAssessment
    public var followUpQuestions: [String]
    public var gitBlame: String
    public var selectedFile: String
    public var selectedLine: Int
    public var selectedCode: String
}

public struct ArchitectureDecision: Hashable {
    public var context: String
    public var decision: String
    public var alternatives: [DecisionOption]
    public var evidence: [String]
    public var consequences: String
    public var externalConstraints: [ExternalConstraint]

    public init(context: String, decision: String, alternatives: [DecisionOption], evidence: [String], consequences: String, externalConstraints: [ExternalConstraint]) {
        self.context = context
        self.decision = decision
        self.alternatives = alternatives
        self.evidence = evidence
        self.consequences = consequences
        self.externalConstraints = externalConstraints
    }
}

public struct GitLineEvidence: Hashable {
    public var commitSHA: String
    public var authorName: String
    public var authorEmail: String
    public var authorDate: String
    public var committerName: String
    public var committerEmail: String
    public var committerDate: String
    public var summary: String
    public var filename: String
    public var rawBlame: String

    public init(
        commitSHA: String,
        authorName: String,
        authorEmail: String,
        authorDate: String,
        committerName: String,
        committerEmail: String,
        committerDate: String,
        summary: String,
        filename: String,
        rawBlame: String
    ) {
        self.commitSHA = commitSHA
        self.authorName = authorName
        self.authorEmail = authorEmail
        self.authorDate = authorDate
        self.committerName = committerName
        self.committerEmail = committerEmail
        self.committerDate = committerDate
        self.summary = summary
        self.filename = filename
        self.rawBlame = rawBlame
    }

    public static let empty = GitLineEvidence(
        commitSHA: "Unknown",
        authorName: "Unknown",
        authorEmail: "Unknown",
        authorDate: "Unknown",
        committerName: "Unknown",
        committerEmail: "Unknown",
        committerDate: "Unknown",
        summary: "Unknown",
        filename: "Unknown",
        rawBlame: ""
    )
}

public struct DecisionProvenance: Hashable {
    public var label: String
    public var detail: String
    public var evidence: [String]

    public init(label: String, detail: String, evidence: [String]) {
        self.label = label
        self.detail = detail
        self.evidence = evidence
    }
}

public struct EvidenceCard: Identifiable, Hashable {
    public var id: String
    public var title: String
    public var kind: String
    public var body: String

    public init(id: String, title: String, kind: String, body: String) {
        self.id = id
        self.title = title
        self.kind = kind
        self.body = body
    }
}

public struct RemovalAssessment: Hashable {
    public var risk: String
    public var referencesCount: Int
    public var testCoverage: String
    public var assessment: String
    public var recommendedNextStep: String
}
