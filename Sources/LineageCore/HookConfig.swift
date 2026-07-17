import Foundation

public enum HookConfig {
    public static var codexConfig: String {
        codexConfig(command: "lineage-capture")
    }

    public static func codexConfig(command: String) -> String {
        let escapedCommand = command
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return """
    [features]
    hooks = true

    [[hooks.SessionStart]]
    matcher = "startup|resume|clear|compact"

    [[hooks.SessionStart.hooks]]
    type = "command"
    command = "\(escapedCommand)"
    timeout = 10
    statusMessage = "Starting Lineage provenance capture"

    [[hooks.UserPromptSubmit]]

    [[hooks.UserPromptSubmit.hooks]]
    type = "command"
    command = "\(escapedCommand)"
    timeout = 10
    statusMessage = "Capturing Codex prompt provenance"

    [[hooks.PreToolUse]]
    matcher = "Bash|apply_patch|Edit|Write|Read|mcp__.*"

    [[hooks.PreToolUse.hooks]]
    type = "command"
    command = "\(escapedCommand)"
    timeout = 10
    statusMessage = "Capturing planned Codex tool use"

    [[hooks.PermissionRequest]]
    matcher = "Bash|apply_patch|Edit|Write|Read|mcp__.*"

    [[hooks.PermissionRequest.hooks]]
    type = "command"
    command = "\(escapedCommand)"
    timeout = 10
    statusMessage = "Capturing Codex permission request"

    [[hooks.PostToolUse]]
    matcher = "Bash|apply_patch|Edit|Write|Read|mcp__.*"

    [[hooks.PostToolUse.hooks]]
    type = "command"
    command = "\(escapedCommand)"
    timeout = 10
    statusMessage = "Capturing Codex tool result"

    [[hooks.Stop]]

    [[hooks.Stop.hooks]]
    type = "command"
    command = "\(escapedCommand)"
    timeout = 30
    statusMessage = "Finalising Lineage provenance"
    """
    }

    public static var githubCopilotCLIConfig: String {
        githubCopilotCLIConfig(command: "lineage-capture")
    }

    public static func githubCopilotCLIConfig(command: String) -> String {
        let hook: [String: Any] = [
            "type": "command",
            "command": command,
            "env": ["LINEAGE_PROVIDER": AIProvider.githubCopilot.id],
            "timeoutSec": 30
        ]
        let hooks: [String: Any] = [
            "SessionStart": [hook],
            "UserPromptSubmit": [hook],
            "PreToolUse": [hook.merging(["matcher": "*"]) { _, new in new }],
            "PermissionRequest": [hook.merging(["matcher": "*"]) { _, new in new }],
            "PostToolUse": [hook.merging(["matcher": "*"]) { _, new in new }],
            "PostToolUseFailure": [hook.merging(["matcher": "*"]) { _, new in new }],
            "Stop": [hook],
            "SessionEnd": [hook]
        ]
        let object: [String: Any] = ["version": 1, "hooks": hooks]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let config = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return config + "\n"
    }
}
