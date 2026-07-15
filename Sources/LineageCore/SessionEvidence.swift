import Foundation

public struct SessionTranscriptMessage: Codable, Identifiable, Hashable {
    public var id: String
    public var timestamp: String?
    public var role: String
    public var title: String
    public var body: String

    public init(id: String = UUID().uuidString, timestamp: String? = nil, role: String, title: String, body: String) {
        self.id = id
        self.timestamp = timestamp
        self.role = role
        self.title = title
        self.body = body
    }
}

public struct SessionTimelineEvent: Codable, Identifiable, Hashable {
    public var id: String
    public var group: String
    public var title: String
    public var detail: String

    enum CodingKeys: String, CodingKey {
        case id
        case group
        case title
        case detail
    }

    public init(id: String = UUID().uuidString, group: String, title: String, detail: String) {
        self.id = id
        self.group = group
        self.title = title
        self.detail = detail
    }
}

public struct SessionEvidenceBundle: Codable, Hashable {
    public var sessionID: String
    public var provider: String
    public var source: String
    public var model: String?
    public var permissionMode: String?
    public var transcriptPath: String?
    public var transcriptAvailable: Bool
    public var prompt: String
    public var finalMessage: String
    public var toolsUsed: [String]
    public var commandsRun: [String]
    public var permissionRequests: [String]
    public var filesEdited: [String]
    public var lineRanges: [LineRange]
    public var timeline: [SessionTimelineEvent]
    public var testsRun: [String]
    public var testsResult: String
    public var gitDiff: String
    public var commitSHA: String?
    public var commitMessage: String?
    public var messages: [SessionTranscriptMessage]
}

public struct SessionEvidenceLoader {
    public init() {}

    public func load(session: ProvenanceSession) -> SessionEvidenceBundle {
        let messages = loadMessages(path: session.transcriptPath)
        let timeline = timelineEvents(session: session)
        return SessionEvidenceBundle(
            sessionID: session.sessionID,
            provider: session.providerDisplayName,
            source: session.source,
            model: session.model,
            permissionMode: session.permissionMode,
            transcriptPath: session.transcriptPath,
            transcriptAvailable: session.transcriptPath.map { FileManager.default.fileExists(atPath: $0) } ?? false,
            prompt: SecretRedactor.redact(session.prompt),
            finalMessage: SecretRedactor.redact(session.lastAssistantMessage),
            toolsUsed: session.toolsUsed.map(SecretRedactor.redact),
            commandsRun: session.commandsRun.map(SecretRedactor.redact),
            permissionRequests: session.permissionRequests.map(SecretRedactor.redact),
            filesEdited: session.filesEdited,
            lineRanges: session.lineRanges,
            timeline: timeline,
            testsRun: session.testsRun.map(SecretRedactor.redact),
            testsResult: SecretRedactor.redact(session.testsResult),
            gitDiff: SecretRedactor.redact(session.gitDiff),
            commitSHA: session.commitSHA,
            commitMessage: session.commitMessage,
            messages: messages
        )
    }

    private func timelineEvents(session: ProvenanceSession) -> [SessionTimelineEvent] {
        var events: [SessionTimelineEvent] = []
        if !session.prompt.isEmpty {
            events.append(SessionTimelineEvent(group: "Prompt", title: "User prompt", detail: SecretRedactor.redact(session.prompt)))
        }
        for tool in session.toolsUsed {
            events.append(SessionTimelineEvent(group: "Tool", title: tool, detail: "Tool used by \(session.providerDisplayName)."))
        }
        for command in session.commandsRun {
            events.append(SessionTimelineEvent(group: "Tool", title: "Command", detail: SecretRedactor.redact(command)))
        }
        for decision in session.decisions {
            let detail = [
                decision.context,
                decision.selectedOptionText.map { "Selected: \($0)" },
                decision.freeformResponse.map { "Freeform: \($0)" },
                decision.permissionStatus.map { "Permission: \($0)" },
                decision.consequences.map { "Consequences: \($0)" }
            ].compactMap { $0 }.joined(separator: "\n")
            events.append(SessionTimelineEvent(group: "Decision", title: decision.kind, detail: SecretRedactor.redact(detail)))
        }
        for constraint in session.externalConstraints {
            events.append(SessionTimelineEvent(group: "Constraint", title: constraint.locationLabel, detail: SecretRedactor.redact(constraint.summary)))
        }
        for test in session.testsRun {
            events.append(SessionTimelineEvent(group: "Test", title: test, detail: "Result: \(SecretRedactor.redact(session.testsResult))"))
        }
        if !session.lastAssistantMessage.isEmpty {
            events.append(SessionTimelineEvent(group: "Final response", title: "Final provider message", detail: SecretRedactor.redact(session.lastAssistantMessage)))
        }
        return events
    }

    private func loadMessages(path: String?) -> [SessionTranscriptMessage] {
        guard let path, FileManager.default.fileExists(atPath: path),
              let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
        return text
            .split(separator: "\n")
            .enumerated()
            .compactMap { index, rawLine in
                parseLine(String(rawLine), fallbackID: "\(index)")
            }
    }

    private func parseLine(_ line: String, fallbackID: String) -> SessionTranscriptMessage? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let payload = object["payload"] as? [String: Any] ?? object
        let timestamp = object["timestamp"] as? String
        let payloadType = payload["type"] as? String
        let id = (payload["id"] as? String) ?? (payload["call_id"] as? String) ?? fallbackID

        if payloadType == "user_message", let message = payload["message"] as? String {
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "user", title: "User", body: SecretRedactor.redact(message))
        }
        if payloadType == "agent_message", let message = payload["message"] as? String {
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "assistant", title: "Assistant", body: SecretRedactor.redact(message))
        }
        if payloadType == "function_call" || payloadType == "custom_tool_call" {
            let name = payload["name"] as? String ?? "Tool"
            let body = (payload["arguments"] as? String) ?? (payload["input"] as? String) ?? ""
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "tool", title: name, body: SecretRedactor.redact(body))
        }
        if payloadType == "function_call_output" || payloadType == "custom_tool_call_output" {
            let body = (payload["output"] as? String) ?? (payload["stdout"] as? String) ?? ""
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "tool", title: "Tool result", body: SecretRedactor.redact(body))
        }
        if let eventType = payloadType, eventType.localizedCaseInsensitiveContains("permission") || eventType.localizedCaseInsensitiveContains("approval") {
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "permission", title: eventType, body: SecretRedactor.redact(String(describing: payload)))
        }

        let role = (payload["role"] as? String) ?? payloadType
        let body = (payload["message"] as? String)
            ?? (payload["content"] as? String)
            ?? (payload["text"] as? String)
        if let role, let body, ["user", "assistant", "agent", "system"].contains(role.lowercased()) {
            let normalizedRole = role.lowercased() == "agent" ? "assistant" : role.lowercased()
            return SessionTranscriptMessage(
                id: id,
                timestamp: timestamp,
                role: normalizedRole,
                title: normalizedRole == "user" ? "User" : (normalizedRole == "assistant" ? "Assistant" : "System"),
                body: SecretRedactor.redact(body)
            )
        }

        if let toolName = (payload["toolName"] as? String) ?? (payload["tool_name"] as? String) {
            let input = payload["toolArgs"] ?? payload["tool_input"] ?? payload["input"] ?? payload["toolResult"] ?? payload["tool_result"]
            return SessionTranscriptMessage(
                id: id,
                timestamp: timestamp,
                role: "tool",
                title: toolName,
                body: SecretRedactor.redact(input.map { String(describing: $0) } ?? "")
            )
        }
        return nil
    }
}

public enum SessionEvidenceExporter {
    public static func markdown(bundle: SessionEvidenceBundle) -> String {
        """
        # Lineage Session Evidence

        Provider: \(bundle.provider)
        Source: \(bundle.source)
        Session: \(bundle.sessionID)
        Model: \(bundle.model ?? "Unknown")
        Permission mode: \(bundle.permissionMode ?? "Unknown")
        Commit: \([bundle.commitSHA, bundle.commitMessage].compactMap { $0 }.joined(separator: " - "))
        Transcript path: \(bundle.transcriptPath ?? "Unavailable")
        Transcript available: \(bundle.transcriptAvailable ? "yes" : "no")

        Note: This export contains captured provider transcript/events and Git evidence only. It does not include or claim private model reasoning.

        ## Prompt

        \(bundle.prompt)

        ## Final Message

        \(bundle.finalMessage)

        ## Tools

        \(bundle.toolsUsed.map { "- \($0)" }.joined(separator: "\n"))

        ## Commands

        \(bundle.commandsRun.map { "- `\($0)`" }.joined(separator: "\n"))

        ## Permissions

        \(bundle.permissionRequests.map { "- \($0)" }.joined(separator: "\n"))

        ## Tests

        Result: \(bundle.testsResult)

        \(bundle.testsRun.map { "- `\($0)`" }.joined(separator: "\n"))

        ## Files Edited

        \(bundle.filesEdited.map { "- \($0)" }.joined(separator: "\n"))

        ## Line Ranges

        \(bundle.lineRanges.map { "- \($0.file):\($0.start)-\($0.end) (\(Int($0.confidence * 100))%, \($0.label))" }.joined(separator: "\n"))

        ## Event Timeline

        \(bundle.timeline.map { "- [\($0.group)] \($0.title): \($0.detail)" }.joined(separator: "\n"))

        ## Transcript

        \(bundle.messages.map { "### \($0.title)\n\n\($0.body)" }.joined(separator: "\n\n"))

        ## Git Diff

        ```diff
        \(bundle.gitDiff)
        ```
        """
    }

    public static func jsonData(bundle: SessionEvidenceBundle) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(bundle)
    }
}

public enum SecretRedactor {
    public static func redact(_ value: String) -> String {
        var output = value
        let patterns = [
            #"sk-[A-Za-z0-9_\-]{20,}"#,
            #"sk-proj-[A-Za-z0-9_\-]{20,}"#,
            #"(?i)bearer\s+[A-Za-z0-9._\-]{12,}"#,
            #"(?i)(authorization:\s*)(Bearer\s+)?[A-Za-z0-9._\-]{12,}"#,
            #"(?i)\b(api[_-]?key|token|secret|password|passwd|auth[_-]?token)\s*=\s*['\"]?[^'\"\s]+"#
        ]
        for pattern in patterns {
            output = output.replacingOccurrences(of: pattern, with: "[REDACTED]", options: .regularExpression)
        }
        return output
    }
}
