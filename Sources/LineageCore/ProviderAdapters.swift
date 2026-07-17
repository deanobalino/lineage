import Foundation

public protocol ProvenanceProviderAdapter {
    var provider: AIProvider { get }
    func canonicalEvent(
        rawObject: [String: Any],
        payloadObject: [String: Any],
        cwd: URL,
        repoRoot: URL,
        environment: [String: String],
        git: GitService
    ) -> LineageEvent
}

public struct ProviderAdapterRegistry {
    public static let shared = ProviderAdapterRegistry(
        adapters: CodingHarnessPluginRegistry.shared.plugins.map(\.adapter)
    )

    private let adapters: [String: ProvenanceProviderAdapter]

    public init(adapters: [ProvenanceProviderAdapter]) {
        self.adapters = Dictionary(uniqueKeysWithValues: adapters.map { ($0.provider.id, $0) })
    }

    public func adapter(for providerID: String?) -> ProvenanceProviderAdapter {
        if let providerID, let adapter = adapters[providerID] {
            return adapter
        }
        return adapters[AIProvider.codex.id] ?? CodexProviderAdapter()
    }
}

public struct GitHubCopilotProviderAdapter: ProvenanceProviderAdapter {
    public let provider = AIProvider.githubCopilot

    public init() {}

    public func canonicalEvent(
        rawObject: [String: Any],
        payloadObject: [String: Any],
        cwd: URL,
        repoRoot: URL,
        environment: [String: String],
        git: GitService
    ) -> LineageEvent {
        var event = CodexProviderAdapter().canonicalEvent(
            rawObject: rawObject,
            payloadObject: payloadObject,
            cwd: cwd,
            repoRoot: repoRoot,
            environment: environment,
            git: git
        )
        event.provider = provider.id
        event.actor = provider.displayName
        if event.providerEventName == "Stop" {
            // Copilot's Stop alias is an end-of-turn event. SessionEnd is the
            // lifecycle boundary used to finalise the repository diff.
            event.eventType = "agent_stop"
        }
        if event.sessionID.hasPrefix("codex-") {
            event.sessionID = "github-copilot-\(Int(Date().timeIntervalSince1970))"
        }
        return event
    }
}

public struct CodexProviderAdapter: ProvenanceProviderAdapter {
    public let provider = AIProvider.codex

    public init() {}

    public func canonicalEvent(
        rawObject: [String: Any],
        payloadObject: [String: Any],
        cwd: URL,
        repoRoot: URL,
        environment: [String: String],
        git: GitService
    ) -> LineageEvent {
        let eventName = string(from: rawObject, keys: ["provider_event_name", "hook_event_name", "hookEventName", "event", "name"])
            ?? environment["LINEAGE_HOOK_EVENT"]
            ?? "Unknown"
        let eventType = string(from: rawObject, keys: ["event_type", "eventType"]) ?? CanonicalEventType.from(providerEventName: eventName)
        let payload = EventPayload(
            prompt: string(from: payloadObject, keys: ["prompt", "user_prompt"]),
            toolName: string(from: payloadObject, keys: ["tool_name", "toolName", "tool"]),
            toolUseID: string(from: payloadObject, keys: ["tool_use_id", "toolUseID", "id"]),
            toolInput: jsonObject(from: payloadObject["tool_input"] ?? payloadObject["toolInput"] ?? payloadObject["toolArgs"] ?? payloadObject["input"]),
            toolResponse: jsonObject(from: payloadObject["tool_response"] ?? payloadObject["toolResponse"] ?? payloadObject["tool_result"] ?? payloadObject["toolResult"] ?? payloadObject["error"] ?? payloadObject["response"]),
            approvalReason: string(from: payloadObject, keys: ["approval_reason", "approvalReason", "reason"]),
            approvalStatus: string(from: payloadObject, keys: ["approval_status", "approvalStatus", "status", "decision"]),
            lastAssistantMessage: string(from: payloadObject, keys: ["last_assistant_message", "lastAssistantMessage", "assistant_message"]),
            gitStatus: string(from: payloadObject, keys: ["git_status", "gitStatus"]) ?? git.run(["status", "--short"], in: repoRoot),
            gitDiff: string(from: payloadObject, keys: ["git_diff", "gitDiff"]) ?? git.run(["diff"], in: repoRoot),
            gitHead: string(from: payloadObject, keys: ["git_head", "gitHead"]) ?? git.run(["rev-parse", "--short", "HEAD"], in: repoRoot),
            changedFiles: stringArray(from: payloadObject, key: "changed_files") ?? changedFiles(repo: repoRoot, git: git),
            testsDetected: stringArray(from: payloadObject, key: "tests_detected"),
            testsResult: string(from: payloadObject, keys: ["tests_result", "testsResult"]),
            optionsPresented: decisionOptions(from: payloadObject["options_presented"] ?? payloadObject["optionsPresented"] ?? payloadObject["alternatives"]),
            selectedOptionText: string(from: payloadObject, keys: ["selected_option_text", "selectedOptionText", "selected_option", "selection_text"]),
            freeformResponse: string(from: payloadObject, keys: ["freeform_response", "freeformResponse", "user_response", "response_text"]),
            decisionContext: string(from: payloadObject, keys: ["decision_context", "decisionContext", "context"]),
            decisionConsequences: string(from: payloadObject, keys: ["decision_consequences", "decisionConsequences", "consequences", "risk"]),
            externalConstraints: externalConstraints(from: payloadObject["external_constraints"] ?? payloadObject["externalConstraints"] ?? payloadObject["spec_references"] ?? payloadObject["specReferences"]),
            rawProviderPayload: JSONValue.fromAny(payloadObject)
        )

        return LineageEvent(
            source: "provider-hook",
            provider: provider.id,
            providerEventName: eventName,
            eventType: eventType,
            actor: provider.displayName,
            human: string(from: rawObject, keys: ["human", "user", "human_reviewer"]),
            hookEventName: eventName,
            sessionID: string(from: rawObject, keys: ["session_id", "sessionID", "sessionId"]) ?? environment["CODEX_SESSION_ID"] ?? "codex-\(Int(Date().timeIntervalSince1970))",
            turnID: string(from: rawObject, keys: ["turn_id", "turnID", "turnId"]) ?? environment["CODEX_TURN_ID"],
            cwd: cwd.path,
            repoRoot: repoRoot.path,
            model: string(from: rawObject, keys: ["model"]) ?? environment["CODEX_MODEL"],
            permissionMode: string(from: rawObject, keys: ["permission_mode", "permissionMode"]) ?? environment["CODEX_PERMISSION_MODE"],
            transcriptPath: string(from: rawObject, keys: ["transcript_path", "transcriptPath"]) ?? environment["CODEX_TRANSCRIPT_PATH"],
            payload: payload
        )
    }
}

private func string(from object: [String: Any], keys: [String]) -> String? {
    for key in keys {
        if let value = object[key] as? String, !value.isEmpty {
            return value
        }
    }
    return nil
}

private func stringArray(from object: [String: Any], key: String) -> [String]? {
    if let values = object[key] as? [String] {
        return values
    }
    return nil
}

private func jsonObject(from value: Any?) -> JSONValue? {
    guard let value else { return nil }
    return JSONValue.fromAny(value)
}

private func decisionOptions(from value: Any?) -> [DecisionOption]? {
    guard let value else { return nil }
    if let strings = value as? [String] {
        return strings.map { DecisionOption(text: $0) }
    }
    if let objects = value as? [[String: Any]] {
        return objects.compactMap { object in
            guard let text = string(from: object, keys: ["text", "option", "label", "title"]) else { return nil }
            return DecisionOption(
                id: string(from: object, keys: ["id"]) ?? UUID().uuidString,
                text: text,
                rationale: string(from: object, keys: ["rationale", "reason", "summary"])
            )
        }
    }
    return nil
}

private func externalConstraints(from value: Any?) -> [ExternalConstraint]? {
    guard let value else { return nil }
    if let strings = value as? [String] {
        return strings.map { ExternalConstraint(filePath: "Unknown", summary: $0, source: "provider_payload") }
    }
    if let objects = value as? [[String: Any]] {
        return objects.compactMap { object in
            guard let summary = string(from: object, keys: ["summary", "constraint", "text", "excerpt"]) else { return nil }
            return ExternalConstraint(
                id: string(from: object, keys: ["id"]) ?? UUID().uuidString,
                filePath: string(from: object, keys: ["file_path", "filePath", "path"]) ?? "Unknown",
                startLine: int(from: object, keys: ["start_line", "startLine", "line"]),
                endLine: int(from: object, keys: ["end_line", "endLine"]),
                excerpt: string(from: object, keys: ["excerpt", "quote"]),
                summary: summary,
                source: string(from: object, keys: ["source", "capture_source"]) ?? "provider_payload"
            )
        }
    }
    return nil
}

private func int(from object: [String: Any], keys: [String]) -> Int? {
    for key in keys {
        if let value = object[key] as? Int {
            return value
        }
        if let value = object[key] as? String, let intValue = Int(value) {
            return intValue
        }
    }
    return nil
}

private func changedFiles(repo: URL, git: GitService) -> [String] {
    let tracked = git.run(["diff", "--name-only"], in: repo)
        .split(separator: "\n")
        .map(String.init)
    let untracked = git.run(["ls-files", "--others", "--exclude-standard"], in: repo)
        .split(separator: "\n")
        .map(String.init)
    return Array(Set(tracked + untracked))
        .filter { !$0.hasPrefix(".lineage/") }
        .sorted()
}
