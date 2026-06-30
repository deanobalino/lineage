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
}
