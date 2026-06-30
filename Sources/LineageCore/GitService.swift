import Foundation

public struct GitService {
    public init() {}

    public func run(_ arguments: [String], in repo: URL) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.currentDirectoryURL = repo
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return ""
        }
    }

    public func succeeds(_ arguments: [String], in repo: URL) -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git"] + arguments
        process.currentDirectoryURL = repo
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    public func repoRoot(from cwd: URL) -> URL? {
        let output = run(["rev-parse", "--show-toplevel"], in: cwd)
        guard !output.isEmpty, !output.contains("fatal:") else { return nil }
        return URL(fileURLWithPath: output)
    }

    public func snapshot(repo: URL) -> RepositorySnapshot {
        let branch = run(["branch", "--show-current"], in: repo)
        let branches = branchNames(repo: repo, currentBranch: branch)
        let latest = run(["log", "--oneline", "-n", "1"], in: repo)
        let store = ProvenanceStore(repoRoot: repo)
        let sessions = store.sessions()
        let fileList = run(["ls-files"], in: repo)
            .split(separator: "\n")
            .map(String.init)
            .filter { !$0.hasPrefix(".lineage/") && !$0.hasPrefix(".git/") }
            .map { path in
                RepoFile(path: path, provenanceProviders: providers(for: path, sessions: sessions))
            }
        let summary = store.summary(files: fileList.map(\.path))
        return RepositorySnapshot(
            root: repo,
            name: repo.lastPathComponent,
            branch: branch.isEmpty ? "Detached HEAD" : branch,
            branches: branches,
            latestCommit: latest.isEmpty ? "No commits" : latest,
            files: fileList,
            provenanceSummary: summary
        )
    }

    public func defaultReviewBase(repo: URL, currentBranch: String) -> String {
        let candidates = [
            "origin/main",
            "main",
            "upstream/main",
            "origin/master",
            "master",
            run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], in: repo)
        ].filter { !$0.isEmpty && $0 != currentBranch }
        return candidates.first { succeeds(["rev-parse", "--verify", "--quiet", $0], in: repo) } ?? currentBranch
    }

    public func reviewSnapshot(repo: URL, baseBranch: String) -> ReviewSnapshot {
        let headBranch = run(["branch", "--show-current"], in: repo)
        let effectiveHead = headBranch.isEmpty ? "HEAD" : headBranch
        let mergeBase = run(["merge-base", baseBranch, "HEAD"], in: repo)
        let baseRange = mergeBase.isEmpty ? "\(baseBranch)...HEAD" : "\(mergeBase)..HEAD"
        let store = ProvenanceStore(repoRoot: repo)
        let sessions = store.sessions()
        let changed = parseNameStatus(run(["diff", "--name-status", "\(baseBranch)...HEAD"], in: repo), sessions: sessions)
        let commits = parseCommits(run(["log", "--oneline", baseRange], in: repo))
        let linkedSessions = Array(Set(changed.flatMap { $0.providerSessions.map(\.sessionID) })).count
        let filesWithProvenance = changed.filter { !$0.providerSessions.isEmpty }.count
        let summary = ReviewSummary(
            filesChanged: changed.count,
            commitsOnBranch: commits.count,
            providerSessionsLinked: linkedSessions,
            filesWithRecordedProvenance: filesWithProvenance,
            filesInferredFromGitOnly: max(0, changed.count - filesWithProvenance)
        )
        return ReviewSnapshot(
            baseBranch: baseBranch,
            headBranch: effectiveHead,
            mergeBase: mergeBase,
            changedFiles: changed,
            commits: commits,
            summary: summary
        )
    }

    public func fileDiff(repo: URL, baseBranch: String, file: ReviewChangedFile) -> FileDiff {
        let diffText = run(["diff", "--unified=80", "\(baseBranch)...HEAD", "--", file.oldPath ?? file.path, file.path], in: repo)
        let headBlame = blameIdentities(repo: repo, revision: "HEAD", file: file.path)
        let baseBlame = blameIdentities(repo: repo, revision: baseBranch, file: file.oldPath ?? file.path)
        let sessions = ProvenanceStore(repoRoot: repo).sessions()
        return FileDiff(file: file, hunks: parseHunks(diffText, file: file, headBlame: headBlame, baseBlame: baseBlame, sessions: sessions))
    }

    public func branchNames(repo: URL, currentBranch: String) -> [String] {
        let local = run(["for-each-ref", "--format=%(refname:short)", "refs/heads"], in: repo)
            .split(separator: "\n")
            .map(String.init)
        let remote = run(["for-each-ref", "--format=%(refname:short)", "refs/remotes"], in: repo)
            .split(separator: "\n")
            .map(String.init)
            .filter { !$0.hasSuffix("/HEAD") }
        let ordered = Array(Set(local + remote)).sorted { lhs, rhs in
            let lhsRemote = lhs.contains("/")
            let rhsRemote = rhs.contains("/")
            if lhsRemote != rhsRemote {
                return !lhsRemote && rhsRemote
            }
            return lhs.localizedStandardCompare(rhs) == .orderedAscending
        }
        if ordered.isEmpty {
            return [currentBranch.isEmpty ? "Detached HEAD" : currentBranch]
        }
        if currentBranch.isEmpty {
            return ["Detached HEAD"] + ordered
        }
        return ordered
    }

    public func reviewBaseBranches(repo: URL, currentBranch: String) -> [String] {
        branchNames(repo: repo, currentBranch: currentBranch)
            .filter { $0 != currentBranch && $0 != "Detached HEAD" }
    }

    public func hasUncommittedChanges(repo: URL) -> Bool {
        !run(["status", "--porcelain"], in: repo).isEmpty
    }

    public func switchBranch(repo: URL, branch: String) -> String {
        guard branch != "Detached HEAD" else {
            return "Cannot switch to Detached HEAD from the branch picker."
        }
        if localBranchExists(repo: repo, branch: branch) {
            return run(["switch", branch], in: repo)
        }
        if remoteBranchExists(repo: repo, branch: branch) {
            let localName = suggestedLocalName(forRemoteBranch: branch)
            if localBranchExists(repo: repo, branch: localName) {
                return run(["switch", localName], in: repo)
            }
            return run(["switch", "--track", branch], in: repo)
        }
        return run(["switch", branch], in: repo)
    }

    private func localBranchExists(repo: URL, branch: String) -> Bool {
        succeeds(["show-ref", "--verify", "--quiet", "refs/heads/\(branch)"], in: repo)
    }

    private func remoteBranchExists(repo: URL, branch: String) -> Bool {
        succeeds(["show-ref", "--verify", "--quiet", "refs/remotes/\(branch)"], in: repo)
    }

    private func suggestedLocalName(forRemoteBranch branch: String) -> String {
        branch.split(separator: "/", maxSplits: 1).dropFirst().first.map(String.init) ?? branch
    }

    public func blame(repo: URL, file: String, line: Int, revision: String? = nil) -> String {
        var arguments = ["blame", "--line-porcelain", "-L", "\(line),\(line)"]
        if let revision, !revision.isEmpty {
            arguments.append(revision)
        }
        arguments.append(contentsOf: ["--", file])
        return run(arguments, in: repo)
    }

    public func blameIdentities(repo: URL, revision: String? = nil, file: String) -> [Int: GitLineIdentity] {
        var arguments = ["blame", "--line-porcelain"]
        if let revision, !revision.isEmpty {
            arguments.append(revision)
        }
        arguments.append(contentsOf: ["--", file])
        return parseBlameIdentities(run(arguments, in: repo))
    }

    public func show(repo: URL, commit: String) -> String {
        run(["show", "--stat", "--patch", commit], in: repo)
    }

    public func references(repo: URL, symbol: String) -> Int {
        guard !symbol.isEmpty else { return 0 }
        let output = run(["grep", "-n", symbol], in: repo)
        return output.isEmpty ? 0 : output.split(separator: "\n").count
    }

    private func parseNameStatus(_ output: String, sessions: [ProvenanceSession]) -> [ReviewChangedFile] {
        output
            .split(separator: "\n")
            .compactMap { rawLine in
                let parts = rawLine.split(separator: "\t").map(String.init)
                guard parts.count >= 2 else { return nil }
                let status = parts[0]
                let path = parts.count >= 3 ? parts[2] : parts[1]
                let oldPath = parts.count >= 3 ? parts[1] : nil
                let linked = sessions.filter { session in
                    session.filesEdited.contains(path) || session.lineRanges.contains { $0.file == path }
                }
                return ReviewChangedFile(status: status, path: path, oldPath: oldPath, providerSessions: linked)
            }
    }

    private func providers(for path: String, sessions: [ProvenanceSession]) -> [String] {
        Array(Set(sessions.compactMap { session in
            let touchesFile = session.filesEdited.contains(path)
                || session.lineRanges.contains { $0.file == path }
            return touchesFile ? session.providerDisplayName : nil
        })).sorted()
    }

    private func parseCommits(_ output: String) -> [ReviewCommit] {
        output.split(separator: "\n").compactMap { rawLine in
            let line = String(rawLine)
            guard let space = line.firstIndex(of: " ") else { return nil }
            return ReviewCommit(
                sha: String(line[..<space]),
                summary: String(line[line.index(after: space)...])
            )
        }
    }

    private func parseHunks(_ diff: String, file: ReviewChangedFile, headBlame: [Int: GitLineIdentity], baseBlame: [Int: GitLineIdentity], sessions: [ProvenanceSession]) -> [DiffHunk] {
        var hunks: [DiffHunk] = []
        var currentHeader: String?
        var currentLines: [DiffLine] = []
        var oldLine = 0
        var newLine = 0
        var hunkOldStart = 0
        var hunkNewStart = 0

        func flush() {
            guard let currentHeader else { return }
            hunks.append(DiffHunk(header: currentHeader, oldStart: hunkOldStart, newStart: hunkNewStart, lines: currentLines))
            currentLines = []
        }

        for rawLine in diff.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            if rawLine.hasPrefix("@@") {
                flush()
                currentHeader = rawLine
                let starts = parseHunkStarts(rawLine)
                oldLine = starts.old
                newLine = starts.new
                hunkOldStart = oldLine
                hunkNewStart = newLine
                currentLines.append(DiffLine(kind: "hunk", oldLine: nil, newLine: nil, text: rawLine))
                continue
            }
            guard currentHeader != nil else { continue }
            if rawLine.hasPrefix("+") && !rawLine.hasPrefix("+++") {
                let identity = headBlame[newLine]
                let provenance = provenanceMatch(sessions: sessions, file: file.path, line: newLine)
                currentLines.append(DiffLine(kind: "addition", oldLine: nil, newLine: newLine, text: String(rawLine.dropFirst()), commitSHA: identity?.shortSHA, commitSummary: identity?.summary, badge: provenance?.provider, confidence: provenance?.confidence))
                newLine += 1
            } else if rawLine.hasPrefix("-") && !rawLine.hasPrefix("---") {
                let identity = baseBlame[oldLine]
                let provenance = provenanceMatch(sessions: sessions, file: file.oldPath ?? file.path, line: oldLine)
                currentLines.append(DiffLine(kind: "deletion", oldLine: oldLine, newLine: nil, text: String(rawLine.dropFirst()), commitSHA: identity?.shortSHA, commitSummary: identity?.summary, badge: provenance?.provider, confidence: provenance?.confidence))
                oldLine += 1
            } else {
                let text = rawLine.hasPrefix(" ") ? String(rawLine.dropFirst()) : rawLine
                let identity = headBlame[newLine] ?? baseBlame[oldLine]
                let provenance = provenanceMatch(sessions: sessions, file: file.path, line: newLine)
                currentLines.append(DiffLine(kind: "context", oldLine: oldLine, newLine: newLine, text: text, commitSHA: identity?.shortSHA, commitSummary: identity?.summary, badge: provenance?.provider, confidence: provenance?.confidence))
                oldLine += 1
                newLine += 1
            }
        }
        flush()
        return hunks
    }

    private func provenanceMatch(sessions: [ProvenanceSession], file: String, line: Int) -> (provider: String, confidence: Double)? {
        for session in sessions {
            if let range = session.lineRanges.first(where: { $0.contains(file: file, line: line) }) {
                return (session.providerDisplayName, range.confidence)
            }
        }
        return nil
    }

    private func parseHunkStarts(_ header: String) -> (old: Int, new: Int) {
        let parts = header.split(separator: " ")
        let oldPart = parts.first { $0.hasPrefix("-") }?.dropFirst().split(separator: ",").first
        let newPart = parts.first { $0.hasPrefix("+") }?.dropFirst().split(separator: ",").first
        return (Int(oldPart ?? "1") ?? 1, Int(newPart ?? "1") ?? 1)
    }

    private func parseBlameIdentities(_ blame: String) -> [Int: GitLineIdentity] {
        var identities: [Int: GitLineIdentity] = [:]
        var currentSHA: String?
        var currentFinalLine: Int?
        var currentSummary = "Unknown"

        for line in blame.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let parts = line.split(separator: " ", maxSplits: 3).map(String.init)
            if parts.count >= 3, parts[0].count >= 7, isCommitSHA(parts[0]) {
                currentSHA = parts[0]
                currentFinalLine = Int(parts[2])
                currentSummary = "Unknown"
                continue
            }
            if line.hasPrefix("summary ") {
                currentSummary = String(line.dropFirst("summary ".count))
                continue
            }
            if line.hasPrefix("\t"), let sha = currentSHA, let finalLine = currentFinalLine {
                identities[finalLine] = GitLineIdentity(commitSHA: sha, summary: currentSummary)
                resetBlameState(&currentSHA, &currentFinalLine, &currentSummary)
            }
        }
        return identities
    }

    private func isCommitSHA(_ value: String) -> Bool {
        value.allSatisfy { character in
            character.isNumber || ("a"..."f").contains(character) || ("A"..."F").contains(character)
        }
    }

    private func resetBlameState(_ sha: inout String?, _ line: inout Int?, _ summary: inout String) {
        sha = nil
        line = nil
        summary = "Unknown"
    }
}
