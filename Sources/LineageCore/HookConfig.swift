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
        let hooks: [String: Any] = [
            "SessionStart": [githubCopilotHook(command: command, eventName: "SessionStart")],
            "UserPromptSubmit": [githubCopilotHook(command: command, eventName: "UserPromptSubmit")],
            "PreToolUse": [githubCopilotHook(command: command, eventName: "PreToolUse", matcher: "*")],
            "PermissionRequest": [githubCopilotHook(command: command, eventName: "PermissionRequest", matcher: "*")],
            "PostToolUse": [githubCopilotHook(command: command, eventName: "PostToolUse", matcher: "*")],
            "PostToolUseFailure": [githubCopilotHook(command: command, eventName: "PostToolUseFailure", matcher: "*")],
            "Stop": [githubCopilotHook(command: command, eventName: "Stop")],
            "SessionEnd": [githubCopilotHook(command: command, eventName: "SessionEnd")]
        ]
        let object: [String: Any] = ["version": 1, "hooks": hooks]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]),
              let config = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return config + "\n"
    }

    private static func githubCopilotHook(command: String, eventName: String, matcher: String? = nil) -> [String: Any] {
        var hook: [String: Any] = [
            "type": "command",
            "command": command,
            "env": [
                "LINEAGE_PROVIDER": AIProvider.githubCopilot.id,
                "LINEAGE_HOOK_EVENT": eventName
            ],
            "timeoutSec": 30
        ]
        if let matcher {
            hook["matcher"] = matcher
        }
        return hook
    }
}
