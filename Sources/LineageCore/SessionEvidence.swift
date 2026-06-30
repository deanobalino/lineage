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
            testsRun: session.testsRun.map(SecretRedactor.redact),
            testsResult: SecretRedactor.redact(session.testsResult),
            gitDiff: SecretRedactor.redact(session.gitDiff),
            commitSHA: session.commitSHA,
            commitMessage: session.commitMessage,
            messages: messages
        )
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
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let payload = object["payload"] as? [String: Any] else { return nil }
        let timestamp = object["timestamp"] as? String
        let payloadType = payload["type"] as? String
        let id = (payload["id"] as? String) ?? (payload["call_id"] as? String) ?? fallbackID

        if payloadType == "user_message", let message = payload["message"] as? String {
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "user", title: "User", body: SecretRedactor.redact(message))
        }
        if payloadType == "agent_message", let message = payload["message"] as? String {
            return SessionTranscriptMessage(id: id, timestamp: timestamp, role: "assistant", title: "Codex", body: SecretRedactor.redact(message))
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
