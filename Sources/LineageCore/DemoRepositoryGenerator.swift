import Foundation

public struct DemoRepositoryGenerator {
    public init() {}

    public func createOrResetDemoRepository() throws -> URL {
        let appSupport = try FileManager.default.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ).appendingPathComponent("Lineage", isDirectory: true)
        let repo = appSupport.appendingPathComponent("DemoRepo/demo-auth-service", isDirectory: true)
        if FileManager.default.fileExists(atPath: repo.path) {
            try FileManager.default.removeItem(at: repo)
        }
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try writeDemoFiles(repo: repo)

        let git = GitService()
        _ = git.run(["init"], in: repo)
        _ = git.run(["config", "user.name", "Lineage Demo"], in: repo)
        _ = git.run(["config", "user.email", "demo@lineage.local"], in: repo)

        try commit(repo: repo, message: "Initial auth retry policy") {
            try write("""
            class AuthenticationBackoffExceeded(RuntimeError):
                pass
            """, to: repo.appendingPathComponent("src/auth/errors.py"))
            try write("""
            from .errors import AuthenticationBackoffExceeded

            MAX_AUTH_RETRIES = 3

            def should_retry_auth_failure(retries: int, error_code: str) -> bool:
                if retries >= MAX_AUTH_RETRIES:
                    raise AuthenticationBackoffExceeded("Authentication retry limit reached")
                return error_code in {"SQL_TIMEOUT", "AAD_THROTTLED"}
            """, to: repo.appendingPathComponent("src/auth/retry_policy.py"))
        }

        try commit(repo: repo, message: "Add bounded retry behaviour") {
            try write("""
            from .errors import AuthenticationBackoffExceeded

            TRANSIENT_AUTH_ERRORS = {"SQL_TIMEOUT", "AAD_THROTTLED", "CONNECTION_RESET"}
            MAX_AUTH_RETRIES = 5

            def should_retry_auth_failure(retries: int, error_code: str) -> bool:
                if retries >= MAX_AUTH_RETRIES:
                    raise AuthenticationBackoffExceeded("Stopping before auth failures are masked")
                return error_code in TRANSIENT_AUTH_ERRORS
            """, to: repo.appendingPathComponent("src/auth/retry_policy.py"))
        }

        try commit(repo: repo, message: "Codex hotfix for Azure SQL transient latency") {
            try write("""
            from .errors import AuthenticationBackoffExceeded

            TRANSIENT_AUTH_ERRORS = {"SQL_TIMEOUT", "AAD_THROTTLED", "CONNECTION_RESET", "AZURE_SQL_LOGIN_DELAY"}
            MAX_AUTH_RETRIES = 7

            def should_retry_auth_failure(retries: int, error_code: str) -> bool:
                if retries > MAX_AUTH_RETRIES:
                    raise AuthenticationBackoffExceeded("Stopping before auth failures are masked")
                return error_code in TRANSIENT_AUTH_ERRORS
            """, to: repo.appendingPathComponent("src/auth/retry_policy.py"))
        }
        let codexCommit = git.run(["rev-parse", "--short", "HEAD"], in: repo)
        _ = git.run(["branch", "codex/azure-sql-hotfix", codexCommit], in: repo)

        try commit(repo: repo, message: "Add tests covering retry limit") {
            try write("""
            import pytest

            from src.auth.errors import AuthenticationBackoffExceeded
            from src.auth.retry_policy import MAX_AUTH_RETRIES, should_retry_auth_failure

            def test_azure_sql_transient_latency_gets_bounded_retries():
                assert MAX_AUTH_RETRIES == 7
                assert should_retry_auth_failure(6, "AZURE_SQL_LOGIN_DELAY") is True

            def test_real_auth_failures_stay_bounded():
                with pytest.raises(AuthenticationBackoffExceeded):
                    should_retry_auth_failure(8, "AZURE_SQL_LOGIN_DELAY")

            def test_non_transient_error_is_not_retried():
                assert should_retry_auth_failure(0, "INVALID_PASSWORD") is False
            """, to: repo.appendingPathComponent("tests/test_retry_policy.py"))
        }

        try commit(repo: repo, message: "Add TODO to revisit threshold") {
            try write("""
            # demo-auth-service

            Small Python service used by Lineage to demonstrate Codex provenance mapped to code lines.

            TODO: revisit `MAX_AUTH_RETRIES` after deployment telemetry confirms Azure SQL login latency has stabilized.
            """, to: repo.appendingPathComponent("README.md"))
        }

        try write(HookConfig.codexConfig, to: repo.appendingPathComponent(".codex/config.toml"))
        try writeDemoProvenance(repo: repo, codexCommit: codexCommit)
        return repo
    }

    private func writeDemoFiles(repo: URL) throws {
        let directories = [
            "src/auth",
            "tests",
            ".lineage/provenance/sessions",
            ".codex"
        ]
        for directory in directories {
            try FileManager.default.createDirectory(at: repo.appendingPathComponent(directory), withIntermediateDirectories: true)
        }
        try write("", to: repo.appendingPathComponent("src/__init__.py"))
        try write("", to: repo.appendingPathComponent("src/auth/__init__.py"))
    }

    private func commit(repo: URL, message: String, changes: () throws -> Void) throws {
        try changes()
        let git = GitService()
        _ = git.run(["add", "."], in: repo)
        _ = git.run(["commit", "-m", message], in: repo)
    }

    private func writeDemoProvenance(repo: URL, codexCommit: String) throws {
        let store = ProvenanceStore(repoRoot: repo)
        try store.ensureDirectories()
        let sessionID = "codex-2026-06-29-001"
        let prompt = "Fix intermittent Azure SQL authentication deployment failures without masking real authentication failures. Keep retries bounded and add tests."
        let diff = """
        diff --git a/src/auth/retry_policy.py b/src/auth/retry_policy.py
        --- a/src/auth/retry_policy.py
        +++ b/src/auth/retry_policy.py
        @@ -1,8 +1,8 @@
         from .errors import AuthenticationBackoffExceeded

        -TRANSIENT_AUTH_ERRORS = {"SQL_TIMEOUT", "AAD_THROTTLED", "CONNECTION_RESET"}
        -MAX_AUTH_RETRIES = 5
        +TRANSIENT_AUTH_ERRORS = {"SQL_TIMEOUT", "AAD_THROTTLED", "CONNECTION_RESET", "AZURE_SQL_LOGIN_DELAY"}
        +MAX_AUTH_RETRIES = 7

         def should_retry_auth_failure(retries: int, error_code: str) -> bool:
        -    if retries >= MAX_AUTH_RETRIES:
        +    if retries > MAX_AUTH_RETRIES:
                 raise AuthenticationBackoffExceeded("Stopping before auth failures are masked")
             return error_code in TRANSIENT_AUTH_ERRORS
        """
        let events: [LineageEvent] = [
            LineageEvent(hookEventName: "SessionStart", sessionID: sessionID, turnID: "turn-001", cwd: repo.path, repoRoot: repo.path, model: "gpt-5-codex", permissionMode: "on-request", transcriptPath: "~/.codex/sessions/demo.jsonl", payload: EventPayload()),
            LineageEvent(hookEventName: "UserPromptSubmit", sessionID: sessionID, turnID: "turn-001", cwd: repo.path, repoRoot: repo.path, model: "gpt-5-codex", permissionMode: "on-request", transcriptPath: "~/.codex/sessions/demo.jsonl", payload: EventPayload(prompt: prompt)),
            LineageEvent(hookEventName: "PreToolUse", sessionID: sessionID, turnID: "turn-001", cwd: repo.path, repoRoot: repo.path, model: "gpt-5-codex", permissionMode: "on-request", transcriptPath: "~/.codex/sessions/demo.jsonl", payload: EventPayload(toolName: "Bash", toolUseID: "tool-001", toolInput: .object(["command": .string("pytest tests/test_retry_policy.py")]))),
            LineageEvent(hookEventName: "PostToolUse", sessionID: sessionID, turnID: "turn-001", cwd: repo.path, repoRoot: repo.path, model: "gpt-5-codex", permissionMode: "on-request", transcriptPath: "~/.codex/sessions/demo.jsonl", payload: EventPayload(toolName: "Bash", toolUseID: "tool-001", toolInput: .object(["command": .string("pytest tests/test_retry_policy.py")]), toolResponse: .object(["exit_code": .number(0), "summary": .string("3 passed")]))),
            LineageEvent(hookEventName: "PermissionRequest", sessionID: sessionID, turnID: "turn-001", cwd: repo.path, repoRoot: repo.path, model: "gpt-5-codex", permissionMode: "on-request", transcriptPath: "~/.codex/sessions/demo.jsonl", payload: EventPayload(toolName: "apply_patch", approvalReason: "Human approved bounded retry hotfix for deployment stability.")),
            LineageEvent(hookEventName: "Stop", sessionID: sessionID, turnID: "turn-001", cwd: repo.path, repoRoot: repo.path, model: "gpt-5-codex", permissionMode: "on-request", transcriptPath: "~/.codex/sessions/demo.jsonl", payload: EventPayload(lastAssistantMessage: "Raised retry threshold to 7, kept the failure boundary explicit, and added tests to ensure real authentication failures are still bounded.", gitStatus: "", gitDiff: diff, changedFiles: ["src/auth/retry_policy.py", "tests/test_retry_policy.py"], testsDetected: ["pytest tests/test_retry_policy.py"], testsResult: "passed"))
        ]
        for event in events {
            try store.append(event: event)
        }
        let session = ProvenanceSession(
            sessionID: sessionID,
            turnID: "turn-001",
            model: "gpt-5-codex",
            prompt: prompt,
            toolsUsed: ["Bash", "apply_patch", "Read"],
            commandsRun: ["pytest tests/test_retry_policy.py"],
            filesEdited: ["src/auth/retry_policy.py", "tests/test_retry_policy.py"],
            testsRun: ["pytest tests/test_retry_policy.py"],
            testsResult: "passed",
            permissionRequests: ["Human approved bounded retry hotfix for deployment stability."],
            lastAssistantMessage: "Raised retry threshold to 7, kept the failure boundary explicit, and added tests to ensure real authentication failures are still bounded.",
            gitDiff: diff,
            commitSHA: codexCommit,
            commitMessage: "Codex hotfix for Azure SQL transient latency",
            reasoningSummary: "Codex raised the retry ceiling only for recorded transient Azure SQL login latency while preserving a hard stop for real authentication failures.",
            lineRanges: [
                LineRange(file: "src/auth/retry_policy.py", start: 3, end: 8, confidence: 0.96, label: "Recorded")
            ]
        )
        try store.write(session: session)
    }

    private func write(_ text: String, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try text.write(to: url, atomically: true, encoding: .utf8)
    }
}
