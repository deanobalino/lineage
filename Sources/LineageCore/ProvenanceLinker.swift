import Foundation

public struct ProvenanceLinker {
    public init() {}

    public func link(repoRoot: URL) throws {
        let store = ProvenanceStore(repoRoot: repoRoot)
        let grouped = Dictionary(grouping: store.events()) { event in
            "\(event.provider)::\(event.sessionID)"
        }
        for (_, events) in grouped {
            let ordered = events.sorted { $0.capturedAt < $1.capturedAt }
            guard let first = ordered.first else { continue }
            let sessionID = first.sessionID
            let provider = first.provider
            let providerDisplayName = AIProvider.displayName(for: provider)
            let prompt = ordered.compactMap { $0.payload.prompt }.last ?? ""
            let tools = Array(Set(ordered.compactMap { $0.payload.toolName })).sorted()
            let commands = ordered.compactMap { event -> String? in
                guard event.payload.toolName == "Bash" else { return nil }
                return event.payload.toolInput?["command"]?.stringValue ?? event.payload.toolInput?["cmd"]?.stringValue
            }
            let stop = ordered.last { $0.eventType == CanonicalEventType.sessionStop || $0.providerEventName == "Stop" }
            let files = stop?.payload.changedFiles ?? inferFiles(from: stop?.payload.gitDiff ?? "")
            let tests = stop?.payload.testsDetected ?? commands.filter { $0.contains("pytest") || $0.contains("swift test") || $0.contains("xcodebuild test") }
            let decisions = decisionRecords(from: ordered)
            let constraints = externalConstraints(from: ordered)
            let git = GitService()
            let startHead = ordered.first?.payload.gitHead
            let stopHead = stop?.payload.gitHead
            let stopDiff = stop?.payload.gitDiff ?? ""
            let headMoved = startHead != nil && stopHead != nil && startHead != stopHead
            let commitHead = headMoved ? stopHead : nil
            let message = commitHead == nil
                ? git.run(["log", "-1", "--pretty=%s"], in: repoRoot)
                : git.run(["log", "-1", "--pretty=%s", commitHead ?? ""], in: repoRoot)
            let lineRanges = inferRanges(files: files, diff: stopDiff)
            let summary = prompt.isEmpty
                ? "Recorded \(providerDisplayName) provenance captured tool usage, edits, tests, and final session evidence."
                : "\(providerDisplayName) acted on the captured prompt: \(prompt)"
            let session = ProvenanceSession(
                provider: provider,
                providerDisplayName: providerDisplayName,
                sessionID: sessionID,
                turnID: ordered.compactMap(\.turnID).last,
                source: provider,
                actor: providerDisplayName,
                human: ordered.compactMap(\.human).last,
                model: ordered.compactMap(\.model).last,
                permissionMode: ordered.compactMap(\.permissionMode).last,
                transcriptPath: ordered.compactMap(\.transcriptPath).last,
                prompt: prompt,
                toolsUsed: tools,
                commandsRun: commands,
                filesEdited: files,
                testsRun: tests,
                testsResult: stop?.payload.testsResult ?? "unknown",
                permissionRequests: ordered.filter { $0.eventType == CanonicalEventType.permissionRequest || $0.providerEventName == "PermissionRequest" }.map { event in
                    let status = event.payload.approvalStatus.map { " (\($0))" } ?? ""
                    return event.payload.approvalReason ?? "Permission requested for \(event.payload.toolName ?? "tool")\(status)"
                },
                decisions: decisions,
                externalConstraints: constraints,
                lastAssistantMessage: stop?.payload.lastAssistantMessage ?? "",
                gitDiff: stopDiff,
                commitSHA: commitHead,
                commitMessage: commitHead == nil || message.isEmpty ? nil : message,
                reasoningSummary: summary,
                lineRanges: lineRanges
            )
            try store.write(session: session)
        }
    }

    private func inferFiles(from diff: String) -> [String] {
        diff.split(separator: "\n").compactMap { line in
            guard line.hasPrefix("+++ b/") else { return nil }
            return String(line.dropFirst(6))
        }
    }

    private func decisionRecords(from events: [LineageEvent]) -> [DecisionRecord] {
        var records: [DecisionRecord] = []
        var pendingOptions: [DecisionOption] = []
        var pendingContext = ""
        for event in events {
            switch event.eventType {
            case CanonicalEventType.assistantOptionsPresented:
                pendingOptions = event.payload.optionsPresented ?? []
                pendingContext = event.payload.decisionContext ?? event.payload.prompt ?? "Agent presented options."
            case CanonicalEventType.userDecision:
                let freeform = event.payload.freeformResponse
                let selected = event.payload.selectedOptionText
                let kind = freeform == nil ? "user_selected_option" : "user_freeform_direction"
                records.append(DecisionRecord(
                    kind: kind,
                    context: event.payload.decisionContext ?? pendingContext,
                    selectedOptionText: selected,
                    freeformResponse: freeform,
                    alternatives: event.payload.optionsPresented ?? pendingOptions,
                    evidence: [event.providerEventName],
                    consequences: event.payload.decisionConsequences
                ))
                pendingOptions = []
                pendingContext = ""
            case CanonicalEventType.permissionDecision:
                records.append(DecisionRecord(
                    kind: "permission_decision",
                    context: event.payload.decisionContext ?? event.payload.approvalReason ?? "Agent requested permission.",
                    selectedOptionText: nil,
                    freeformResponse: event.payload.freeformResponse,
                    alternatives: event.payload.optionsPresented ?? [],
                    permissionStatus: event.payload.approvalStatus,
                    evidence: [event.providerEventName],
                    consequences: event.payload.decisionConsequences
                ))
            case CanonicalEventType.permissionRequest:
                if let approvalStatus = event.payload.approvalStatus {
                    records.append(DecisionRecord(
                        kind: "permission_decision",
                        context: event.payload.approvalReason ?? "Agent requested permission for \(event.payload.toolName ?? "tool").",
                        permissionStatus: approvalStatus,
                        evidence: [event.providerEventName],
                        consequences: event.payload.decisionConsequences
                    ))
                }
            default:
                continue
            }
        }
        return records
    }

    private func externalConstraints(from events: [LineageEvent]) -> [ExternalConstraint] {
        var constraints = events.flatMap { $0.payload.externalConstraints ?? [] }
        let readDerived = events.compactMap { event -> ExternalConstraint? in
            guard event.eventType == CanonicalEventType.postToolUse || event.eventType == CanonicalEventType.preToolUse,
                  ["Read", "Grep", "Glob"].contains(event.payload.toolName ?? "") else { return nil }
            let path = event.payload.toolInput?["file_path"]?.stringValue
                ?? event.payload.toolInput?["path"]?.stringValue
                ?? event.payload.toolInput?["pattern"]?.stringValue
            guard let path, isLikelySpecPath(path) else { return nil }
            return ExternalConstraint(
                filePath: path,
                summary: "Provider read this external document during the session.",
                source: "tool_call"
            )
        }
        constraints.append(contentsOf: readDerived)
        return Array(Set(constraints))
    }

    private func isLikelySpecPath(_ path: String) -> Bool {
        let lower = path.lowercased()
        return lower.contains("spec") || lower.contains("adr") || lower.contains("requirements") || lower.hasSuffix(".md")
    }

    private func inferRanges(files: [String], diff: String) -> [LineRange] {
        var ranges: [LineRange] = []
        var currentFile: String?
        for rawLine in diff.split(separator: "\n").map(String.init) {
            if rawLine.hasPrefix("+++ b/") {
                currentFile = String(rawLine.dropFirst(6))
            } else if rawLine.hasPrefix("@@"), let file = currentFile, files.contains(file) {
                let parts = rawLine.split(separator: " ")
                guard parts.count > 2 else { continue }
                let newRange = parts[2].dropFirst()
                let numbers = newRange.split(separator: ",")
                let start = Int(numbers.first ?? "1") ?? 1
                let count = Int(numbers.dropFirst().first ?? "1") ?? 1
                ranges.append(LineRange(file: file, start: start, end: max(start, start + count - 1), confidence: 0.92, label: "Recorded"))
            }
        }
        if ranges.isEmpty {
            ranges = files.map { LineRange(file: $0, start: 1, end: 999, confidence: 0.7, label: "Recorded") }
        }
        return ranges
    }
}
