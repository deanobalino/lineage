import SwiftUI
import AppKit
import LineageCore

@main
struct LineageApp: App {
    @StateObject private var state = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(state)
                .frame(minWidth: 1280, minHeight: 760)
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("Open Repository...") {
                    state.chooseRepository()
                }
                .keyboardShortcut("o", modifiers: .command)

                Button("Open Demo Repository") {
                    state.openDemoRepository()
                }
                .keyboardShortcut("o", modifiers: [.command, .shift])
            }

            CommandMenu("Lineage") {
                Button("Refresh Repository") {
                    state.refreshRepository()
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(state.repository == nil)

                Button("Review Branch") {
                    state.setWorkspaceMode("review")
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(state.repository == nil)

                Button("Install Codex Capture") {
                    state.installCodexCapture()
                }
                .keyboardShortcut("i", modifiers: [.command, .shift])
                .disabled(state.repository == nil)

                Button("Export Explanation...") {
                    state.exportExplanation()
                }
                .keyboardShortcut("e", modifiers: .command)
                .disabled(state.explanation == nil)

                Button("Export Agent Trace") {
                    state.exportAgentTrace()
                }
                .disabled(state.repository == nil)

                Divider()

                Button("Close Repository") {
                    state.closeRepository()
                }
                .keyboardShortcut("w", modifiers: .command)
                .disabled(state.repository == nil)
            }
        }
    }
}

struct ProjectBookmark: Codable, Identifiable, Hashable {
    var id: String { path }
    var path: String
    var name: String
    var lastOpenedAt: Date

    var url: URL {
        URL(fileURLWithPath: path)
    }
}

@MainActor
final class AppState: ObservableObject {
    @Published var projects: [ProjectBookmark] = []
    @Published var activeProjectPath: String?
    @Published var repository: RepositorySnapshot?
    @Published var selectedFile: RepoFile?
    @Published var codeLines: [CodeLine] = []
    @Published var selectedLine: CodeLine?
    @Published var explanation: LineExplanation?
    @Published var searchText = ""
    @Published var installMessage: String?
    @Published var followUpQuestion = ""
    @Published var followUpAnswer: String?
    @Published var branchMessage: String?
    @Published var isLoadingRepository = false
    @Published var isExplaining = false
    @Published private var hasRestoredInitialProject = false
    @Published var workspaceMode = "explore"
    @Published var reviewBaseBranch = ""
    @Published var reviewBaseBranches: [String] = []
    @Published var reviewSnapshot: ReviewSnapshot?
    @Published var selectedReviewFile: ReviewChangedFile?
    @Published var selectedFileDiff: FileDiff?
    @Published var selectedReviewDiffLine: DiffLine?
    @Published var reviewExplanation: ReviewChangeExplanation?
    @Published var reviewLineExplanation: LineExplanation?
    @Published var isLoadingReview = false
    @Published var isExplainingReviewLine = false
    @Published var selectedSessionPivot: ProvenanceSession?
    @Published var provenanceGraph: ProvenanceGraph?
    @Published var pendingCodeScrollLine: Int?
    @Published var pendingReviewScrollLineID: String?
    @Published var rightPaneCollapseGeneration = 0
    @Published var rightPaneExpandGeneration = 0
    @AppStorage("sidebarWidth") var sidebarWidth: Double = 340
    @AppStorage("rightPaneWidth") var rightPaneWidth: Double = 430
    @AppStorage("projectPaneCollapsed") var projectPaneCollapsed = false
    @Published var expandedDirectories: Set<String> = []

    private let git = GitService()
    private let explanationEngine = ExplanationEngine()
    private let projectsDefaultsKey = "lineage.projects"
    private let activeProjectDefaultsKey = "lineage.activeProjectPath"

    init() {
        projects = Self.loadProjects(key: projectsDefaultsKey)
        activeProjectPath = UserDefaults.standard.string(forKey: activeProjectDefaultsKey)
        if activeProjectPath == nil {
            activeProjectPath = projects.first?.path
        }
    }

    func openRepository(_ url: URL) {
        isLoadingRepository = true
        searchText = ""
        installMessage = nil
        branchMessage = nil
        selectedFile = nil
        selectedLine = nil
        explanation = nil
        codeLines = []

        Task.detached {
            let git = GitService()
            let root = git.repoRoot(from: url) ?? url
            _ = try? CodexTranscriptRecovery().recover(repoRoot: root)
            _ = try? ProvenanceLinker().link(repoRoot: root)
            let snapshot = git.snapshot(repo: root)
            await MainActor.run {
                self.rememberProject(root, name: snapshot.name)
                self.activeProjectPath = root.path
                UserDefaults.standard.set(root.path, forKey: self.activeProjectDefaultsKey)
                self.repository = snapshot
                self.provenanceGraph = ProvenanceStore(repoRoot: root).provenanceGraph()
                self.selectedFile = snapshot.files.first { $0.path.hasSuffix("retry_policy.py") } ?? snapshot.files.first
                self.resetExpandedDirectories(for: snapshot)
                self.isLoadingRepository = false
                self.loadSelectedFile(preselectDemoLine: true)
                self.prepareReviewDefaults(for: snapshot)
            }
        }
    }

    func restoreInitialProjectIfNeeded() {
        guard !hasRestoredInitialProject, repository == nil else { return }
        hasRestoredInitialProject = true
        let project = projects.first { $0.path == activeProjectPath } ?? projects.first
        if let project {
            openProject(project)
        }
    }

    func openProject(_ project: ProjectBookmark) {
        activeProjectPath = project.path
        UserDefaults.standard.set(project.path, forKey: activeProjectDefaultsKey)
        openRepository(project.url)
    }

    func removeProject(_ project: ProjectBookmark) {
        projects.removeAll { $0.path == project.path }
        saveProjects()

        guard activeProjectPath == project.path else { return }
        closeRepository(clearActiveProject: true)
        if let next = projects.first {
            openProject(next)
        } else {
            UserDefaults.standard.removeObject(forKey: activeProjectDefaultsKey)
        }
    }

    func toggleProjectPane() {
        projectPaneCollapsed.toggle()
    }

    func closeRepository() {
        closeRepository(clearActiveProject: false)
    }

    private func closeRepository(clearActiveProject: Bool) {
        repository = nil
        selectedFile = nil
        codeLines = []
        selectedLine = nil
        explanation = nil
        searchText = ""
        installMessage = nil
        branchMessage = nil
        followUpQuestion = ""
        followUpAnswer = nil
        expandedDirectories = []
        workspaceMode = "explore"
        reviewBaseBranch = ""
        reviewBaseBranches = []
        reviewSnapshot = nil
        selectedReviewFile = nil
        selectedFileDiff = nil
        selectedReviewDiffLine = nil
        reviewExplanation = nil
        reviewLineExplanation = nil
        isExplainingReviewLine = false
        selectedSessionPivot = nil
        provenanceGraph = nil
        pendingCodeScrollLine = nil
        pendingReviewScrollLineID = nil
        if clearActiveProject {
            activeProjectPath = nil
            UserDefaults.standard.removeObject(forKey: activeProjectDefaultsKey)
        }
    }

    func openDemoRepository() {
        isLoadingRepository = true
        Task.detached {
            do {
                let repo = try DemoRepositoryGenerator().createOrResetDemoRepository()
                await MainActor.run {
                    self.openRepository(repo)
                }
            } catch {
                await MainActor.run {
                    self.isLoadingRepository = false
                    self.installMessage = "Could not create demo repository: \(error.localizedDescription)"
                }
            }
        }
    }

    func chooseRepository() {
        let panel = NSOpenPanel()
        panel.title = "Add Repository"
        panel.message = "Choose a local Git repository to inspect with Lineage."
        panel.prompt = "Add Repository"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        if panel.runModal() == .OK, let url = panel.url {
            openRepository(url)
        }
    }

    func select(file: RepoFile) {
        selectedFile = file
        loadSelectedFile(preselectDemoLine: false)
    }

    func jumpToRange(_ range: LineRange) {
        guard let repository else { return }
        if workspaceMode == "review", let reviewFile = reviewSnapshot?.changedFiles.first(where: { $0.path == range.file || $0.oldPath == range.file }) {
            if selectedReviewFile?.path == reviewFile.path {
                jumpToReviewLine(range.start)
            } else {
                pendingReviewScrollLineID = nil
                selectReviewFile(reviewFile, focusLine: range.start)
            }
            return
        }

        workspaceMode = "explore"
        pendingCodeScrollLine = range.start
        if selectedFile?.path == range.file {
            if let line = codeLines.first(where: { $0.number == range.start }) {
                select(line: line)
            }
        } else if let file = repository.files.first(where: { $0.path == range.file }) {
            selectedFile = file
            loadSelectedFile(preselectDemoLine: false)
        }
    }

    func collapseRightPaneSections() {
        rightPaneCollapseGeneration += 1
    }

    func expandRightPaneSections() {
        rightPaneExpandGeneration += 1
    }

    func switchBranch(to branch: String) {
        guard let repository, branch != repository.branch else { return }
        isLoadingRepository = true
        let previousFilePath = selectedFile?.path
        Task.detached {
            let git = GitService()
            let output = git.switchBranch(repo: repository.root, branch: branch)
            if output.localizedCaseInsensitiveContains("fatal") || output.localizedCaseInsensitiveContains("error") {
                await MainActor.run {
                    self.isLoadingRepository = false
                    self.branchMessage = output.isEmpty ? "Could not switch to \(branch)." : output
                }
                return
            }
            let snapshot = git.snapshot(repo: repository.root)
            await MainActor.run {
                self.branchMessage = "Showing branch \(branch)."
                self.repository = snapshot
                self.provenanceGraph = ProvenanceStore(repoRoot: repository.root).provenanceGraph()
                self.selectedFile = snapshot.files.first { $0.path == previousFilePath }
                    ?? snapshot.files.first { $0.path.hasSuffix("retry_policy.py") }
                    ?? snapshot.files.first
                self.resetExpandedDirectories(for: snapshot)
                self.isLoadingRepository = false
                self.loadSelectedFile(preselectDemoLine: true)
                self.prepareReviewDefaults(for: snapshot)
            }
        }
    }

    func refreshRepository() {
        guard let repository else { return }
        isLoadingRepository = true
        let previousFilePath = selectedFile?.path
        let previousLine = selectedLine?.number
        Task.detached {
            _ = try? CodexTranscriptRecovery().recover(repoRoot: repository.root)
            _ = try? ProvenanceLinker().link(repoRoot: repository.root)
            let snapshot = GitService().snapshot(repo: repository.root)
            await MainActor.run {
                self.repository = snapshot
                self.provenanceGraph = ProvenanceStore(repoRoot: repository.root).provenanceGraph()
                self.selectedFile = snapshot.files.first { $0.path == previousFilePath }
                    ?? snapshot.files.first { $0.path.hasSuffix("retry_policy.py") }
                    ?? snapshot.files.first
                self.resetExpandedDirectories(for: snapshot)
                self.isLoadingRepository = false
                self.loadSelectedFile(preselectDemoLine: previousLine == nil)
                self.prepareReviewDefaults(for: snapshot)
                if let previousLine, let line = self.codeLines.first(where: { $0.number == previousLine }) {
                    self.select(line: line)
                }
                self.installMessage = "Repository refreshed from Git and Lineage provenance."
            }
        }
    }

    func select(line: CodeLine) {
        selectedLine = line
        explanation = nil
        isExplaining = true
        guard let repository, let selectedFile else {
            isExplaining = false
            return
        }
        Task.detached {
            let explanation = ExplanationEngine().explain(repo: repository.root, file: selectedFile.path, lineNumber: line.number, lineText: line.text)
            await MainActor.run {
                if self.selectedLine?.number == line.number && self.selectedFile?.path == selectedFile.path {
                    self.explanation = explanation
                }
                self.isExplaining = false
            }
        }
        followUpAnswer = nil
    }

    func toggleDirectory(_ path: String) {
        if expandedDirectories.contains(path) {
            expandedDirectories.remove(path)
        } else {
            expandedDirectories.insert(path)
        }
    }

    func isDirectoryExpanded(_ path: String) -> Bool {
        searchText.isEmpty ? expandedDirectories.contains(path) : true
    }

    func resizeSidebar(by translation: CGFloat) {
        sidebarWidth = min(560, max(260, sidebarWidth + Double(translation)))
    }

    func resizeRightPane(startingWidth: Double, translation: CGFloat) {
        rightPaneWidth = min(760, max(340, startingWidth - Double(translation)))
    }

    func setWorkspaceMode(_ mode: String) {
        workspaceMode = mode
        if mode == "review", reviewSnapshot == nil {
            loadReviewSnapshot()
        }
    }

    func switchReviewBase(to baseBranch: String) {
        guard baseBranch != reviewBaseBranch else { return }
        reviewBaseBranch = baseBranch
        loadReviewSnapshot()
    }

    func loadReviewSnapshot() {
        guard let repository, !reviewBaseBranch.isEmpty else { return }
        isLoadingReview = true
        selectedReviewFile = nil
        selectedFileDiff = nil
        selectedReviewDiffLine = nil
        reviewExplanation = nil
        reviewLineExplanation = nil
        isExplainingReviewLine = false
        let base = reviewBaseBranch
        Task.detached {
            _ = try? CodexTranscriptRecovery().recover(repoRoot: repository.root)
            _ = try? ProvenanceLinker().link(repoRoot: repository.root)
            let snapshot = GitService().reviewSnapshot(repo: repository.root, baseBranch: base)
            await MainActor.run {
                self.reviewSnapshot = snapshot
                self.isLoadingReview = false
                if let first = snapshot.changedFiles.first {
                    self.selectReviewFile(first)
                }
            }
        }
    }

    func selectReviewFile(_ file: ReviewChangedFile, focusLine: Int? = nil) {
        guard let repository else { return }
        selectedReviewFile = file
        selectedFileDiff = nil
        selectedReviewDiffLine = nil
        reviewExplanation = nil
        reviewLineExplanation = nil
        isExplainingReviewLine = false
        isLoadingReview = true
        let base = reviewBaseBranch
        Task.detached {
            let diff = GitService().fileDiff(repo: repository.root, baseBranch: base, file: file)
            let explanation = ExplanationEngine().explainChange(repo: repository.root, baseBranch: base, fileDiff: diff)
            await MainActor.run {
                guard self.selectedReviewFile?.path == file.path else { return }
                self.selectedFileDiff = diff
                self.reviewExplanation = explanation
                self.isLoadingReview = false
                if let focusLine {
                    self.jumpToReviewLine(focusLine)
                }
            }
        }
    }

    func jumpToReviewLine(_ lineNumber: Int) {
        guard let diff = selectedFileDiff else {
            pendingReviewScrollLineID = nil
            return
        }
        let line = diff.lines.first { candidate in
            candidate.newLine == lineNumber || candidate.oldLine == lineNumber
        }
        if let line {
            pendingReviewScrollLineID = line.id
            selectReviewLine(line)
        }
    }

    func selectReviewLine(_ line: DiffLine) {
        selectedReviewDiffLine = line
        reviewLineExplanation = nil
        isExplainingReviewLine = true
        guard let repository, let file = selectedReviewFile else {
            isExplainingReviewLine = false
            return
        }
        let isDeletion = line.kind == "deletion"
        let lineNumber = isDeletion ? line.oldLine : (line.newLine ?? line.oldLine)
        guard let lineNumber else {
            isExplainingReviewLine = false
            return
        }
        let filePath = isDeletion ? (file.oldPath ?? file.path) : file.path
        let revision = isDeletion ? reviewBaseBranch : nil
        Task.detached {
            let explanation = ExplanationEngine().explain(
                repo: repository.root,
                file: filePath,
                lineNumber: lineNumber,
                lineText: line.text,
                revision: revision
            )
            await MainActor.run {
                if self.selectedReviewDiffLine?.id == line.id && self.selectedReviewFile?.path == file.path {
                    self.reviewLineExplanation = explanation
                }
                self.isExplainingReviewLine = false
            }
        }
    }

    func installCodexCapture() {
        guard let repository else { return }
        installMessage = "Installing Codex capture..."
        Task.detached {
            do {
                let store = ProvenanceStore(repoRoot: repository.root)
                try store.ensureDirectories()
                let configURL = repository.root.appendingPathComponent(".codex/config.toml")
                try FileManager.default.createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
                let command = try Self.installCollectorCommand()
                let doctorMessage = try Self.checkCollector(command: command, repo: repository.root)
                try HookConfig.codexConfig(command: command).write(to: configURL, atomically: true, encoding: .utf8)
                await MainActor.run {
                    self.installMessage = "Codex capture installed at \(command). \(doctorMessage) Start a new Codex turn in this repo, then click Refresh."
                    self.refreshRepository()
                }
            } catch {
                await MainActor.run {
                    self.installMessage = "Install failed: \(error.localizedDescription)"
                }
            }
        }
    }

    func exportExplanation() {
        guard let explanation, let repository else { return }
        do {
            let url = try MarkdownExporter().export(explanation: explanation, repo: repository.root)
            installMessage = "Exported explanation to \(url.lastPathComponent)."
        } catch {
            installMessage = "Export failed: \(error.localizedDescription)"
        }
    }

    func showSessionPivot(_ session: ProvenanceSession) {
        selectedSessionPivot = session
    }

    func exportAgentTrace() {
        guard let repository else { return }
        do {
            let url = try ProvenanceStore(repoRoot: repository.root).exportAgentTrace()
            installMessage = "Exported Agent Trace records to \(url.path)."
        } catch {
            installMessage = "Agent Trace export failed: \(error.localizedDescription)"
        }
    }

    func askFollowUp(_ question: String? = nil) {
        guard let explanation else { return }
        let selected = question ?? followUpQuestion
        guard !selected.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        followUpQuestion = selected
        followUpAnswer = explanationEngine.answerFollowUp(selected, explanation: explanation)
    }

    private func loadSelectedFile(preselectDemoLine: Bool) {
        guard let repository, let selectedFile else { return }
        expandAncestors(of: selectedFile.path)
        codeLines = []
        selectedLine = nil
        explanation = nil
        Task.detached {
            let url = repository.root.appendingPathComponent(selectedFile.path)
            let contents = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
            let sessions = ProvenanceStore(repoRoot: repository.root).sessions()
            let blameIdentities = GitService().blameIdentities(repo: repository.root, file: selectedFile.path)
            let lines = contents.components(separatedBy: .newlines).enumerated().map { index, text in
                let number = index + 1
                let match = sessions.compactMap { session -> (ProvenanceSession, LineRange)? in
                    guard let range = session.lineRanges.first(where: { $0.contains(file: selectedFile.path, line: number) }) else { return nil }
                    return (session, range)
                }.first
                let identity = blameIdentities[number]
                return CodeLine(
                    number: number,
                    text: text,
                    badge: match?.0.providerDisplayName,
                    confidence: match?.1.confidence,
                    commitSHA: identity?.shortSHA,
                    commitSummary: identity?.summary
                )
            }
            await MainActor.run {
                guard self.selectedFile?.path == selectedFile.path else { return }
                self.codeLines = lines
                if let pending = self.pendingCodeScrollLine,
                   let line = lines.first(where: { $0.number == pending }) {
                    self.select(line: line)
                } else if preselectDemoLine, let line = lines.first(where: { $0.text.contains("MAX_AUTH_RETRIES = 7") }) {
                    self.select(line: line)
                } else if let first = lines.first {
                    self.select(line: first)
                }
            }
        }
    }

    private func prepareReviewDefaults(for snapshot: RepositorySnapshot) {
        reviewBaseBranches = git.reviewBaseBranches(repo: snapshot.root, currentBranch: snapshot.branch)
        let defaultBase = git.defaultReviewBase(repo: snapshot.root, currentBranch: snapshot.branch)
        reviewBaseBranch = reviewBaseBranches.contains(defaultBase) ? defaultBase : (reviewBaseBranches.first ?? "")
        reviewSnapshot = nil
        selectedReviewFile = nil
        selectedFileDiff = nil
        reviewExplanation = nil
        if workspaceMode == "review" {
            loadReviewSnapshot()
        }
    }

    private func resetExpandedDirectories(for snapshot: RepositorySnapshot) {
        var directories = Set<String>()
        for file in snapshot.files.prefix(80) {
            if let first = file.path.split(separator: "/").first {
                directories.insert(String(first))
            }
        }
        if let selectedFile {
            directories.formUnion(ancestors(of: selectedFile.path))
        }
        expandedDirectories = directories
    }

    private func expandAncestors(of filePath: String) {
        expandedDirectories.formUnion(ancestors(of: filePath))
    }

    private func ancestors(of filePath: String) -> Set<String> {
        let parts = filePath.split(separator: "/").map(String.init)
        guard parts.count > 1 else { return [] }
        var paths: Set<String> = []
        var current: [String] = []
        for part in parts.dropLast() {
            current.append(part)
            paths.insert(current.joined(separator: "/"))
        }
        return paths
    }

    private func rememberProject(_ url: URL, name: String) {
        let path = url.path
        let bookmark = ProjectBookmark(path: path, name: name, lastOpenedAt: Date())
        projects.removeAll { $0.path == path }
        projects.insert(bookmark, at: 0)
        saveProjects()
    }

    private func saveProjects() {
        if let data = try? JSONEncoder().encode(projects) {
            UserDefaults.standard.set(data, forKey: projectsDefaultsKey)
        }
    }

    private nonisolated static func loadProjects(key: String) -> [ProjectBookmark] {
        guard let data = UserDefaults.standard.data(forKey: key),
              let projects = try? JSONDecoder().decode([ProjectBookmark].self, from: data) else {
            return []
        }
        return projects
    }

    private nonisolated static func installCollectorCommand() throws -> String {
        let installDirectory = FileManager.default
            .homeDirectoryForCurrentUser
            .appendingPathComponent(".lineage/bin", isDirectory: true)
        try FileManager.default.createDirectory(at: installDirectory, withIntermediateDirectories: true)

        let executableDirectory = Bundle.main.executableURL?.deletingLastPathComponent()
        let sibling = executableDirectory?.appendingPathComponent("lineage-capture")
        if let sibling, FileManager.default.isExecutableFile(atPath: sibling.path) {
            return try copyCollector(from: sibling, to: installDirectory)
        }

        if let packageRoot = findPackageRoot() {
            _ = runProcess(["swift", "build", "--product", "lineage-capture"], in: packageRoot)
            let binPath = runProcess(["swift", "build", "--show-bin-path"], in: packageRoot)
            let builtCollector = URL(fileURLWithPath: binPath).appendingPathComponent("lineage-capture")
            if FileManager.default.isExecutableFile(atPath: builtCollector.path) {
                return try copyCollector(from: builtCollector, to: installDirectory)
            }
        }

        throw NSError(
            domain: "LineageInstall",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "Could not find or build lineage-capture. Run `swift build --product lineage-capture` from the Lineage project, then try again."]
        )
    }

    private nonisolated static func copyCollector(from source: URL, to directory: URL) throws -> String {
        let destination = directory.appendingPathComponent("lineage-capture")
        if FileManager.default.fileExists(atPath: destination.path) {
            try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: source, to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
        return destination.path
    }

    private nonisolated static func checkCollector(command: String, repo: URL) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: command)
        process.arguments = ["--doctor", repo.path]
        process.currentDirectoryURL = repo
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let output = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard process.terminationStatus == 0 else {
            throw NSError(
                domain: "LineageInstall",
                code: Int(process.terminationStatus),
                userInfo: [NSLocalizedDescriptionKey: output.isEmpty ? "Collector self-check failed." : output]
            )
        }
        return output.isEmpty ? "Collector self-check passed." : output
    }

    private nonisolated static func findPackageRoot() -> URL? {
        let candidates = [
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            Bundle.main.executableURL?.deletingLastPathComponent()
        ].compactMap { $0 }

        for start in candidates {
            var current = start
            for _ in 0..<8 {
                if FileManager.default.fileExists(atPath: current.appendingPathComponent("Package.swift").path) {
                    return current
                }
                let parent = current.deletingLastPathComponent()
                if parent.path == current.path { break }
                current = parent
            }
        }
        return nil
    }

    private nonisolated static func runProcess(_ arguments: [String], in directory: URL) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = arguments
        process.currentDirectoryURL = directory
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        } catch {
            return ""
        }
    }
}
