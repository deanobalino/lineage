import Foundation

public struct CodexTranscriptRecovery {
    private let git = GitService()

    public init() {}

    @discardableResult
    public func recover(repoRoot: URL) throws -> Int {
        let store = ProvenanceStore(repoRoot: repoRoot)
        try store.ensureDirectories()

        let existing = Set(store.sessions().map { "\($0.source)::\($0.commitSHA ?? "")" })
        let transcripts = codexTranscriptFiles().compactMap { readTranscript($0, repoRoot: repoRoot) }
        guard !transcripts.isEmpty else { return 0 }

        let commits = branchCommits(repoRoot: repoRoot)
        var imported = 0
        for commit in commits {
            guard let transcript = transcripts.first(where: { $0.matches(commit: commit) }) else { continue }
            let key = "codex-transcript-recovery::\(commit.sha)"
            let alreadyImported = existing.contains(key)

            let diff = git.run(["show", "--format=", "--patch", "--find-renames", commit.sha], in: repoRoot)
            let files = git.run(["show", "--format=", "--name-only", commit.sha], in: repoRoot)
                .split(separator: "\n")
                .map(String.init)
                .filter { !$0.isEmpty && !$0.hasPrefix(".lineage/") }
            let session = ProvenanceSession(
                provider: AIProvider.codex.id,
                providerDisplayName: AIProvider.codex.displayName,
                sessionID: "transcript-\(commit.shortSHA)-\(transcript.sessionID)",
                turnID: nil,
                source: "codex-transcript-recovery",
                actor: AIProvider.codex.displayName,
                model: transcript.model,
                transcriptPath: transcript.path,
                prompt: transcript.prompt,
                toolsUsed: transcript.toolsUsed,
                commandsRun: transcript.commands,
                filesEdited: files,
                testsRun: transcript.testCommands,
                testsResult: transcript.testCommands.isEmpty ? "unknown" : "captured in transcript",
                permissionRequests: [],
                lastAssistantMessage: transcript.lastMessage(for: commit),
                gitDiff: diff,
                commitSHA: commit.sha,
                commitMessage: commit.summary,
                reasoningSummary: "Recovered from a Codex transcript because provider hooks did not write Lineage events for this session. Lineage can show prompts, tool calls, final messages, commit diffs, tests, and Git evidence exposed in the transcript; it does not claim private model reasoning.",
                lineRanges: inferRanges(files: files, diff: diff)
            )
            try store.write(session: session)
            if !alreadyImported {
                imported += 1
            }
        }
        return imported
    }

    private func branchCommits(repoRoot: URL) -> [GitCommit] {
        let current = git.run(["branch", "--show-current"], in: repoRoot)
        let base = git.defaultReviewBase(repo: repoRoot, currentBranch: current)
        let mergeBase = git.run(["merge-base", base, "HEAD"], in: repoRoot)
        let range = mergeBase.isEmpty ? "\(base)..HEAD" : "\(mergeBase)..HEAD"
        let output = git.run(["log", "--reverse", "--pretty=%H%x1f%s", range], in: repoRoot)
        return output.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\u{1f}", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { return nil }
            return GitCommit(sha: parts[0], summary: parts[1])
        }
    }

    private func codexTranscriptFiles() -> [URL] {
        let home = ProcessInfo.processInfo.environment["CODEX_HOME"]
            .map(URL.init(fileURLWithPath:))
            ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".codex", isDirectory: true)
        let sessions = home.appendingPathComponent("sessions", isDirectory: true)
        guard let enumerator = FileManager.default.enumerator(at: sessions, includingPropertiesForKeys: nil) else { return [] }
        return enumerator.compactMap { item in
            guard let url = item as? URL, url.pathExtension == "jsonl" else { return nil }
            return url
        }
    }

    private func readTranscript(_ url: URL, repoRoot: URL) -> CodexTranscript? {
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        var sessionID = url.deletingPathExtension().lastPathComponent
        var model: String?
        var cwdMatches = false
        var prompt = ""
        var agentMessages: [String] = []
        var commands: [String] = []
        var tools: Set<String> = []

        for line in text.split(separator: "\n") {
            guard let data = String(line).data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let payload = object["payload"] as? [String: Any] else { continue }
            if object["type"] as? String == "session_meta" {
                if let id = payload["session_id"] as? String ?? payload["id"] as? String {
                    sessionID = id
                }
                if let actualModel = payload["model"] as? String, !actualModel.isEmpty {
                    model = actualModel
                }
                if let cwd = payload["cwd"] as? String, samePath(cwd, repoRoot.path) {
                    cwdMatches = true
                }
            }
            if payload["type"] as? String == "user_message", let message = payload["message"] as? String {
                if prompt.isEmpty { prompt = message }
            }
            if payload["type"] as? String == "agent_message", let message = payload["message"] as? String {
                agentMessages.append(message)
            }
            if payload["type"] as? String == "function_call", let name = payload["name"] as? String {
                tools.insert(name)
                if name == "exec_command",
                   let arguments = payload["arguments"] as? String,
                   let command = commandFromExecArguments(arguments, repoRoot: repoRoot) {
                    commands.append(command)
                }
            }
            if let name = payload["name"] as? String, payload["type"] == nil {
                tools.insert(name)
            }
        }

        guard cwdMatches else { return nil }
        return CodexTranscript(
            sessionID: sessionID,
            path: url.path,
            model: model,
            prompt: prompt,
            agentMessages: agentMessages,
            commands: commands,
            toolsUsed: Array(tools).sorted()
        )
    }

    private func commandFromExecArguments(_ arguments: String, repoRoot: URL) -> String? {
        guard let data = arguments.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let command = object["cmd"] as? String else { return nil }
        if let workdir = object["workdir"] as? String, !samePath(workdir, repoRoot.path) {
            return nil
        }
        return command
    }

    private func samePath(_ lhs: String, _ rhs: String) -> Bool {
        URL(fileURLWithPath: lhs).standardizedFileURL.path == URL(fileURLWithPath: rhs).standardizedFileURL.path
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
                ranges.append(LineRange(file: file, start: start, end: max(start, start + count - 1), confidence: 0.78, label: "Recovered from Codex transcript"))
            }
        }
        if ranges.isEmpty {
            ranges = files.map { LineRange(file: $0, start: 1, end: 999, confidence: 0.62, label: "Recovered from Codex transcript") }
        }
        return ranges
    }
}

private struct GitCommit {
    var sha: String
    var summary: String
    var shortSHA: String { String(sha.prefix(7)) }
}

private struct CodexTranscript {
    var sessionID: String
    var path: String
    var model: String?
    var prompt: String
    var agentMessages: [String]
    var commands: [String]
    var toolsUsed: [String]

    var testCommands: [String] {
        commands.filter { command in
            command.contains("npm run") || command.contains("swift test") || command.contains("xcodebuild test") || command.contains("pytest")
        }
    }

    func matches(commit: GitCommit) -> Bool {
        let haystack = ([prompt] + agentMessages + commands).joined(separator: "\n")
        return haystack.contains(commit.shortSHA) || haystack.contains(commit.sha) || haystack.contains(commit.summary)
    }

    func lastMessage(for commit: GitCommit) -> String {
        agentMessages.last { message in
            message.contains(commit.shortSHA) || message.contains(commit.summary)
        } ?? agentMessages.last ?? ""
    }
}
