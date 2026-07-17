import Foundation
import LineageCore

if CommandLine.arguments.dropFirst().first == "--doctor" {
    runDoctor()
    exit(0)
}

if CommandLine.arguments.dropFirst().first == "--link" {
    runLink()
    exit(0)
}

if CommandLine.arguments.dropFirst().first == "--verify-line" {
    runVerifyLine()
    exit(0)
}

if CommandLine.arguments.dropFirst().first == "--recover-codex" {
    runRecoverCodex()
    exit(0)
}

let input = FileHandle.standardInput.readDataToEndOfFile()
let object = (try? JSONSerialization.jsonObject(with: input)) as? [String: Any] ?? [:]
let environment = ProcessInfo.processInfo.environment
let cwd = URL(fileURLWithPath: (object["cwd"] as? String) ?? environment["PWD"] ?? FileManager.default.currentDirectoryPath)
let git = GitService()
let repoRoot = git.repoRoot(from: cwd) ?? fallbackDirectory()
let payloadObject = object["payload"] as? [String: Any] ?? object
let providerID = string(from: object, keys: ["provider"]) ?? environment["LINEAGE_PROVIDER"] ?? AIProvider.codex.id
let adapter = ProviderAdapterRegistry.shared.adapter(for: providerID)
var event = adapter.canonicalEvent(rawObject: object, payloadObject: payloadObject, cwd: cwd, repoRoot: repoRoot, environment: environment, git: git)

do {
    let store = ProvenanceStore(repoRoot: repoRoot)
    try applyDirtyWorktreeBaseline(to: &event, store: store, git: git, repoRoot: repoRoot)
    try store.append(event: event)
    if event.eventType == CanonicalEventType.sessionStop {
        try? ProvenanceLinker().link(repoRoot: repoRoot)
    }
    if environment["LINEAGE_CAPTURE_VERBOSE"] == "1" {
        FileHandle.standardOutput.write(Data("lineage-capture: recorded \(event.providerEventName) from \(event.provider)\n".utf8))
    }
} catch {
    FileHandle.standardError.write(Data("lineage-capture: \(error.localizedDescription)\n".utf8))
    exit(1)
}

func string(from object: [String: Any], keys: [String]) -> String? {
    for key in keys {
        if let value = object[key] as? String, !value.isEmpty {
            return value
        }
    }
    return nil
}

func fallbackDirectory() -> URL {
    let base = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
        ?? URL(fileURLWithPath: NSTemporaryDirectory())
    let directory = base.appendingPathComponent("Lineage/FallbackCapture", isDirectory: true)
    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}

struct SessionDiffBaseline: Codable {
    var head: String
    var gitDiff: String
    var changedFiles: [String]
}

func applyDirtyWorktreeBaseline(to event: inout LineageEvent, store: ProvenanceStore, git: GitService, repoRoot: URL) throws {
    switch event.eventType {
    case CanonicalEventType.sessionStart:
        try writeBaseline(for: event, store: store, git: git, repoRoot: repoRoot)
        event.payload.gitDiff = ""
        event.payload.changedFiles = []
    case CanonicalEventType.sessionStop:
        guard let baseline = readBaseline(for: event, store: store) else { return }
        let currentHead = git.run(["rev-parse", "--short", "HEAD"], in: repoRoot)
        event.payload.gitHead = currentHead.isEmpty ? event.payload.gitHead : currentHead
        if !baseline.head.isEmpty, !currentHead.isEmpty, baseline.head != currentHead {
            let range = "\(baseline.head)..HEAD"
            event.payload.gitDiff = git.run(["diff", range], in: repoRoot)
            event.payload.changedFiles = git.run(["diff", "--name-only", range], in: repoRoot)
                .split(separator: "\n")
                .map(String.init)
            try? FileManager.default.removeItem(at: baselineURL(for: event, store: store))
            return
        }
        let currentDiff = event.payload.gitDiff ?? ""
        let currentFiles = event.payload.changedFiles ?? []
        if currentDiff == baseline.gitDiff && Set(currentFiles) == Set(baseline.changedFiles) {
            event.payload.gitDiff = ""
            event.payload.changedFiles = []
        } else if !baseline.changedFiles.isEmpty {
            let existingDirtyFiles = Set(baseline.changedFiles)
            event.payload.changedFiles = currentFiles.filter { !existingDirtyFiles.contains($0) }
            event.payload.gitDiff = ""
        }
        try? FileManager.default.removeItem(at: baselineURL(for: event, store: store))
    default:
        return
    }
}

func writeBaseline(for event: LineageEvent, store: ProvenanceStore, git: GitService, repoRoot: URL) throws {
    let baseline = SessionDiffBaseline(
        head: git.run(["rev-parse", "--short", "HEAD"], in: repoRoot),
        gitDiff: event.payload.gitDiff ?? "",
        changedFiles: event.payload.changedFiles ?? []
    )
    let url = baselineURL(for: event, store: store)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try JSONEncoder().encode(baseline).write(to: url, options: [.atomic])
}

func readBaseline(for event: LineageEvent, store: ProvenanceStore) -> SessionDiffBaseline? {
    let url = baselineURL(for: event, store: store)
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? JSONDecoder().decode(SessionDiffBaseline.self, from: data)
}

func baselineURL(for event: LineageEvent, store: ProvenanceStore) -> URL {
    store.provenanceDirectory
        .appendingPathComponent(".runtime/diff-baselines", isDirectory: true)
        .appendingPathComponent("\(event.provider)-\(safeFilename(event.sessionID)).json")
}

func safeFilename(_ value: String) -> String {
    let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_."))
    return String(value.unicodeScalars.map { allowed.contains($0) ? Character($0) : "-" })
}

func runDoctor() {
    let arguments = Array(CommandLine.arguments.dropFirst().dropFirst())
    let start = arguments.first.map(URL.init(fileURLWithPath:)) ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let git = GitService()
    guard let repoRoot = git.repoRoot(from: start) else {
        FileHandle.standardError.write(Data("lineage-capture doctor: not inside a Git repository\n".utf8))
        exit(2)
    }

    do {
        let store = ProvenanceStore(repoRoot: repoRoot)
        try store.ensureDirectories()
        let checkURL = store.provenanceDirectory.appendingPathComponent(".capture-check")
        try "ok\n".write(to: checkURL, atomically: true, encoding: .utf8)
        _ = try String(contentsOf: checkURL, encoding: .utf8)
        try? FileManager.default.removeItem(at: checkURL)
        FileHandle.standardOutput.write(Data("lineage-capture doctor: ok \(repoRoot.path)\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("lineage-capture doctor: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

func runLink() {
    let arguments = Array(CommandLine.arguments.dropFirst().dropFirst())
    let start = arguments.first.map(URL.init(fileURLWithPath:)) ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let git = GitService()
    guard let repoRoot = git.repoRoot(from: start) else {
        FileHandle.standardError.write(Data("lineage-capture link: not inside a Git repository\n".utf8))
        exit(2)
    }

    do {
        try ProvenanceLinker().link(repoRoot: repoRoot)
        FileHandle.standardOutput.write(Data("lineage-capture link: ok \(repoRoot.path)\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("lineage-capture link: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

func runRecoverCodex() {
    let arguments = Array(CommandLine.arguments.dropFirst().dropFirst())
    let start = arguments.first.map(URL.init(fileURLWithPath:)) ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    let git = GitService()
    guard let repoRoot = git.repoRoot(from: start) else {
        FileHandle.standardError.write(Data("lineage-capture recover-codex: not inside a Git repository\n".utf8))
        exit(2)
    }

    do {
        let imported = try CodexTranscriptRecovery().recover(repoRoot: repoRoot)
        try ProvenanceLinker().link(repoRoot: repoRoot)
        FileHandle.standardOutput.write(Data("lineage-capture recover-codex: imported \(imported) sessions for \(repoRoot.path)\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("lineage-capture recover-codex: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}

func runVerifyLine() {
    let arguments = Array(CommandLine.arguments.dropFirst().dropFirst())
    guard arguments.count >= 3 else {
        FileHandle.standardError.write(Data("lineage-capture verify-line: expected <repo> <file> <text-marker>\n".utf8))
        exit(2)
    }
    let repo = URL(fileURLWithPath: arguments[0])
    let file = arguments[1]
    let marker = arguments.dropFirst(2).joined(separator: " ")
    do {
        let contents = try String(contentsOf: repo.appendingPathComponent(file), encoding: .utf8)
        let lines = contents.components(separatedBy: .newlines)
        guard let index = lines.firstIndex(where: { $0.contains(marker) }) else {
            FileHandle.standardError.write(Data("lineage-capture verify-line: marker not found\n".utf8))
            exit(1)
        }
        let explanation = ExplanationEngine().explain(repo: repo, file: file, lineNumber: index + 1, lineText: lines[index])
        let provider = explanation.providerSession?.providerDisplayName ?? "NONE"
        let session = explanation.providerSession?.sessionID ?? "NONE"
        let output = """
        line=\(index + 1)
        commit=\(explanation.gitEvidence.commitSHA)
        provider=\(provider)
        session=\(session)
        confidence=\(explanation.confidenceLabel)

        """
        FileHandle.standardOutput.write(Data(output.utf8))
        if explanation.providerSession == nil {
            exit(1)
        }
    } catch {
        FileHandle.standardError.write(Data("lineage-capture verify-line: \(error.localizedDescription)\n".utf8))
        exit(1)
    }
}
