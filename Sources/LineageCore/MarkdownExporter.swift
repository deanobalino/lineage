import Foundation

public struct MarkdownExporter {
    public init() {}

    public func export(explanation: LineExplanation, repo: URL) throws -> URL {
        let destination = repo.appendingPathComponent("Lineage Explanation \(explanation.selectedFile.replacingOccurrences(of: "/", with: "-")) line \(explanation.selectedLine).md")
        let session = explanation.providerSession
        let markdown = """
        # Lineage

        Generated: \(ISO8601DateFormatter().string(from: Date()))

        Repository: \(repo.path)
        File: \(explanation.selectedFile):\(explanation.selectedLine)
        Code: `\(explanation.selectedCode.trimmingCharacters(in: .whitespaces))`

        ## Answer

        \(explanation.answer)

        ## Confidence

        \(Int(explanation.confidence * 100))% - \(explanation.confidenceLabel)

        ## AI provider provenance

        Provider: \(session?.providerDisplayName ?? "None")
        Session: \(session?.sessionID ?? "None")
        Model: \(session?.model ?? "Unknown")
        Prompt: \(session?.prompt ?? "No AI provider provenance was captured for this line.")
        Tools: \(session?.toolsUsed.joined(separator: ", ") ?? "None")
        Tests: \(session?.testsRun.joined(separator: ", ") ?? "None")
        Final message: \(session?.lastAssistantMessage ?? "None")

        ## Decision provenance

        \(explanation.decisionProvenance.label)

        \(explanation.decisionProvenance.detail)

        Evidence: \(explanation.decisionProvenance.evidence.joined(separator: ", "))

        \(decisionRecordMarkdown(explanation.architectureDecision))

        ## Git evidence

        Commit: \(explanation.gitEvidence.commitSHA)
        Summary: \(explanation.gitEvidence.summary)
        Author: \(explanation.gitEvidence.authorName) \(explanation.gitEvidence.authorEmail)
        Authored: \(explanation.gitEvidence.authorDate)
        Committer: \(explanation.gitEvidence.committerName) \(explanation.gitEvidence.committerEmail)
        Committed: \(explanation.gitEvidence.committerDate)

        Git author/committer identify what the repository recorded for this commit. They do not, by themselves, prove who wrote the prompt, approved a tool call, or why the line exists.

        ## Farm-to-fork trace

        \(explanation.timeline.map { "- \($0)" }.joined(separator: "\n"))

        ## Evidence

        \(explanation.evidence.map { "### \($0.title)\n\n\($0.body)" }.joined(separator: "\n\n"))

        ## Could we remove this?

        Risk: \(explanation.couldRemove.risk)

        \(explanation.couldRemove.assessment)

        Recommended next step: \(explanation.couldRemove.recommendedNextStep)
        """
        try markdown.write(to: destination, atomically: true, encoding: .utf8)
        return destination
    }

    private func decisionRecordMarkdown(_ decision: ArchitectureDecision?) -> String {
        guard let decision else { return "" }
        let alternatives = decision.alternatives.isEmpty
            ? "None recorded"
            : decision.alternatives.map { "- \($0.text)\($0.rationale.map { ": \($0)" } ?? "")" }.joined(separator: "\n")
        let constraints = decision.externalConstraints.isEmpty
            ? "None recorded"
            : decision.externalConstraints.map { "- \($0.locationLabel): \($0.summary)" }.joined(separator: "\n")
        return """
        ## Decision record

        Context: \(decision.context)

        Decision: \(decision.decision)

        Alternatives considered:
        \(alternatives)

        External constraints:
        \(constraints)

        Evidence: \(decision.evidence.joined(separator: ", "))

        Consequences / risk: \(decision.consequences)
        """
    }
}
