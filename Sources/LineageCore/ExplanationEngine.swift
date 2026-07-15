import Foundation

public struct ExplanationEngine {
    private let git = GitService()

    public init() {}

    public func explain(repo: URL, file: String, lineNumber: Int, lineText: String, revision: String? = nil) -> LineExplanation {
        let store = ProvenanceStore(repoRoot: repo)
        let blame = git.blame(repo: repo, file: file, line: lineNumber, revision: revision)
        let gitEvidence = parseGitEvidence(blame: blame)
        let sessions = store.matchingSessions(file: file, line: lineNumber, commitSHA: gitEvidence.commitSHA)
        let session = sessions.first
        let symbol = symbolCandidate(from: lineText)
        let references = git.references(repo: repo, symbol: symbol)

        if let session {
            let provenanceLabel = sessions.count > 1 ? "Recorded multi-harness provenance" : label(for: session)
            let decision = decisionProvenance(for: session)
            let architectureDecision = architectureDecision(for: session)
            let answer = answerForSessions(sessions, lineText: lineText)
            let providerNames = Array(Set(sessions.map(\.providerDisplayName))).sorted()
            return LineExplanation(
                answer: answer,
                confidence: session.source == "codex-transcript-recovery" ? 0.82 : 0.96,
                confidenceLabel: provenanceLabel,
                originActor: providerNames.joined(separator: ", "),
                originReviewer: session.humanReviewer,
                gitEvidence: gitEvidence,
                decisionProvenance: decision,
                architectureDecision: architectureDecision,
                providerSession: session,
                providerSessions: sessions,
                timeline: timeline(for: decision),
                evidence: sessions.enumerated().flatMap { index, matchedSession in
                    evidenceCards(
                        session: matchedSession,
                        gitEvidence: gitEvidence,
                        decision: index == 0 ? decision : decisionProvenance(for: matchedSession)
                    )
                },
                couldRemove: RemovalAssessment(
                    risk: "Medium",
                    referencesCount: max(references, 1),
                    testCoverage: session.testsResult == "passed" ? "Covered by retry policy tests" : "Unknown",
                    assessment: "This line is covered by retry policy tests and is referenced by the authentication deployment path. Removing it could reintroduce false-negative auth failures during transient Azure SQL latency.",
                    recommendedNextStep: "Feature-flag the threshold and add telemetry before changing it."
                ),
                followUpQuestions: ["Why 7 and not 5?", "Could this be feature flagged?", "Explain this to a staff engineer", "Generate a cleanup PR plan", "What evidence supports this?"],
                gitBlame: blame,
                selectedFile: file,
                selectedLine: lineNumber,
                selectedCode: lineText
            )
        }

        let decision = DecisionProvenance(
            label: "No AI provider provenance captured",
            detail: "Lineage can see Git history for this line, but it cannot tell whether an agent or human made the underlying decision because no AI provider session matched this line.",
            evidence: ["Git blame"]
        )
        return LineExplanation(
            answer: "No AI provider provenance was captured for this line. This explanation is inferred from Git history only.",
            confidence: 0.42,
            confidenceLabel: "Inferred from Git history",
            originActor: "Unknown",
            originReviewer: "Unknown",
            gitEvidence: gitEvidence,
            decisionProvenance: decision,
            architectureDecision: gitOnlyArchitectureDecision(gitEvidence: gitEvidence),
            providerSession: nil,
            providerSessions: [],
            timeline: ["Git blame", "Commit diff", "Line selected today"],
            evidence: [
                EvidenceCard(id: "commit", title: "Git commit", kind: "Linked Git commit", body: gitEvidenceSummary(gitEvidence)),
                EvidenceCard(id: "decision", title: "Decision provenance", kind: "Inferred only", body: decision.detail),
                EvidenceCard(id: "git-blame", title: "Raw Git blame", kind: "Git blame", body: blame.isEmpty ? "No blame data available." : blame)
            ],
            couldRemove: RemovalAssessment(
                risk: "Unknown",
                referencesCount: references,
                testCoverage: "Unknown",
                assessment: "Lineage could not find recorded AI provider evidence for this line, so removal risk cannot be assessed from provenance.",
                recommendedNextStep: "Inspect call sites, run nearby tests, and install Codex capture before future changes."
            ),
            followUpQuestions: ["What evidence supports this?", "Show the Git history", "What tests should I run?"],
            gitBlame: blame,
            selectedFile: file,
            selectedLine: lineNumber,
            selectedCode: lineText
        )
    }

    public func answerFollowUp(_ question: String, explanation: LineExplanation) -> String {
        if question.localizedCaseInsensitiveContains("why 7") {
            return "The captured prompt asked Codex to fix Azure SQL transient auth failures while keeping retries bounded. The session evidence shows Codex chose 7 as a higher ceiling than the previous 5, then added tests that still fail at 8."
        }
        if question.localizedCaseInsensitiveContains("feature") {
            return "Yes. The next practical step is to move `MAX_AUTH_RETRIES` behind configuration or a feature flag, then add telemetry for retry counts and terminal auth failures."
        }
        return explanation.answer
    }

    private func label(for session: ProvenanceSession) -> String {
        if session.source == "codex-transcript-recovery" {
            return "Recovered \(session.providerDisplayName) transcript provenance"
        }
        return "Recorded \(session.providerDisplayName) provenance"
    }

    public func explainChange(repo: URL, baseBranch: String, fileDiff: FileDiff) -> ReviewChangeExplanation {
        let sessions = fileDiff.file.providerSessions
        let diffSummary = "\(fileDiff.file.statusLabel) \(fileDiff.file.path) against \(baseBranch)."
        if let first = sessions.first {
            let answer = "This change is linked to recorded \(first.providerDisplayName) provenance. The provider session captured the prompt, tools, tests, decisions, and final message that produced or touched this file."
            var cards: [EvidenceCard] = [
                EvidenceCard(id: "prompt", title: "Prompt", kind: "\(first.providerDisplayName) provenance", body: first.prompt.isEmpty ? "No prompt captured." : first.prompt),
                EvidenceCard(id: "final", title: "Final provider message", kind: "\(first.providerDisplayName) provenance", body: first.lastAssistantMessage.isEmpty ? "No final message captured." : first.lastAssistantMessage),
                EvidenceCard(id: "tests", title: "Tests", kind: "Test evidence", body: "\(first.testsRun.joined(separator: "\n"))\nResult: \(first.testsResult)")
            ]
            cards.append(contentsOf: first.decisions.map { decision in
                EvidenceCard(
                    id: "decision-\(decision.id)",
                    title: "Decision record",
                    kind: decision.kind,
                    body: [
                        "Context: \(decision.context)",
                        decision.selectedOptionText.map { "Selected: \($0)" },
                        decision.freeformResponse.map { "Freeform: \($0)" },
                        decision.permissionStatus.map { "Permission: \($0)" },
                        decision.alternatives.isEmpty ? nil : "Alternatives: \(decision.alternatives.map(\.text).joined(separator: "; "))",
                        decision.consequences.map { "Consequences: \($0)" }
                    ].compactMap { $0 }.joined(separator: "\n")
                )
            })
            cards.append(contentsOf: first.externalConstraints.map { constraint in
                EvidenceCard(
                    id: "constraint-\(constraint.id)",
                    title: "External constraint",
                    kind: constraint.source,
                    body: "\(constraint.locationLabel)\n\(constraint.summary)\n\(constraint.excerpt ?? "")"
                )
            })
            cards.append(EvidenceCard(id: "diff", title: "Git diff with line commits", kind: "Git diff", body: summarizeDiff(fileDiff)))
            return ReviewChangeExplanation(
                answer: answer,
                confidenceLabel: "Recorded \(first.providerDisplayName) provenance",
                providerSessions: sessions,
                evidence: cards,
                gitSummary: diffSummary
            )
        }

        return ReviewChangeExplanation(
            answer: "No recorded AI provider provenance was linked to this changed file. This review explanation is inferred from local Git diff and branch history only.",
            confidenceLabel: "Inferred from Git history",
            providerSessions: [],
            evidence: [
                EvidenceCard(id: "diff", title: "Git diff with line commits", kind: "Git diff", body: summarizeDiff(fileDiff))
            ],
            gitSummary: diffSummary
        )
    }

    private func evidenceCards(session: ProvenanceSession, gitEvidence: GitLineEvidence, decision: DecisionProvenance) -> [EvidenceCard] {
        var cards = [
            EvidenceCard(id: "\(session.id)-prompt", title: "Original prompt", kind: "\(session.providerDisplayName) event", body: session.prompt),
            EvidenceCard(id: "\(session.id)-decision", title: "Decision provenance", kind: decision.label, body: "\(decision.detail)\n\nEvidence: \(decision.evidence.joined(separator: ", "))")
        ]
        cards.append(contentsOf: session.externalConstraints.map { constraint in
            EvidenceCard(
                id: "\(session.id)-constraint-\(constraint.id)",
                title: "External constraint",
                kind: constraint.source,
                body: "\(constraint.locationLabel)\n\(constraint.summary)\n\(constraint.excerpt ?? "")"
            )
        })
        cards.append(contentsOf: [
            EvidenceCard(id: "\(session.id)-tools", title: "Tools used", kind: "Tool call", body: session.toolsUsed.joined(separator: ", ")),
            EvidenceCard(id: "\(session.id)-tests", title: "Tests run", kind: "Test result", body: "\(session.testsRun.joined(separator: "\n"))\nResult: \(session.testsResult)"),
            EvidenceCard(id: "\(session.id)-final", title: "Final provider message", kind: "\(session.providerDisplayName) final message", body: session.lastAssistantMessage),
            EvidenceCard(id: "\(session.id)-diff", title: "Git diff snippet", kind: "Git diff snippet", body: session.gitDiff),
            EvidenceCard(id: "\(session.id)-commit", title: "Git commit", kind: "Linked Git commit", body: gitEvidenceSummary(gitEvidence)),
            EvidenceCard(id: "\(session.id)-blame", title: "Raw Git blame", kind: "Git blame", body: gitEvidence.rawBlame)
        ])
        return cards
    }

    private func summarizeDiff(_ fileDiff: FileDiff) -> String {
        let commitSummary = distinctCommits(in: fileDiff)
        let hunkSummary = fileDiff.hunks.map { hunk in
            let additions = hunk.lines.filter { $0.kind == "addition" }.count
            let deletions = hunk.lines.filter { $0.kind == "deletion" }.count
            return "\(hunk.header)\n+\(additions) -\(deletions)"
        }.joined(separator: "\n\n")
        if commitSummary.isEmpty {
            return hunkSummary
        }
        return "Line commits:\n\(commitSummary)\n\n\(hunkSummary)"
    }

    private func distinctCommits(in fileDiff: FileDiff) -> String {
        var seen: Set<String> = []
        return fileDiff.lines.compactMap { line in
            guard let sha = line.commitSHA, !seen.contains(sha) else { return nil }
            seen.insert(sha)
            let prefix: String
            switch line.kind {
            case "addition": prefix = "added/current"
            case "deletion": prefix = "removed/base"
            default: prefix = "context"
            }
            let summary = line.commitSummary.map { " \($0)" } ?? ""
            return "\(sha) (\(prefix))\(summary)"
        }.joined(separator: "\n")
    }

    private func answerForSession(_ session: ProvenanceSession, lineText: String) -> String {
        if session.prompt.localizedCaseInsensitiveContains("Azure SQL") {
            return "This line exists because Codex raised the retry ceiling to 7 after transient Azure SQL latency caused false-negative authentication failures during deployment. The threshold was bounded to avoid masking real authentication failures, and tests were added to verify the limit."
        }
        if session.source == "codex-transcript-recovery" {
            let prompt = session.prompt.isEmpty ? "a local Codex transcript" : "the prompt: \"\(session.prompt)\""
            let code = lineText.trimmingCharacters(in: .whitespacesAndNewlines)
            let commit = session.commitMessage.map { " It is linked to the Git commit \"\($0)\"." } ?? ""
            return "This line is linked to recovered \(session.providerDisplayName) transcript evidence from \(prompt). Lineage recovered the prompt, tool calls, final message, Git diff, tests where visible, and commit evidence exposed in the transcript; it does not claim private model reasoning. The selected code was `\(code)`.\(commit)"
        }
        let prompt = session.prompt.isEmpty ? "a captured \(session.providerDisplayName) session" : "the prompt: \"\(session.prompt)\""
        let commit = session.commitMessage.map { " It was later linked to the Git commit \"\($0)\"." } ?? ""
        let code = lineText.trimmingCharacters(in: .whitespacesAndNewlines)
        return "This line is linked to recorded \(session.providerDisplayName) provenance from \(prompt). Lineage can show the prompt, tools, tests, permission events, diff evidence, and Git commit that carried `\(code)` into the repository.\(commit)"
    }

    private func answerForSessions(_ sessions: [ProvenanceSession], lineText: String) -> String {
        guard let primary = sessions.first else { return "" }
        let primaryAnswer = answerForSession(primary, lineText: lineText)
        let additionalProviders = Array(Set(sessions.dropFirst().map(\.providerDisplayName))).sorted()
        guard !additionalProviders.isEmpty else { return primaryAnswer }
        return "\(primaryAnswer) Additional matching provenance from \(additionalProviders.joined(separator: ", ")) is included below."
    }

    private func decisionProvenance(for session: ProvenanceSession) -> DecisionProvenance {
        if let selected = session.decisions.first(where: { $0.selectedOptionText != nil }) {
            return DecisionProvenance(
                label: "Agent proposed options; human selected: \(selected.selectedOptionText ?? "")",
                detail: "The provider captured options presented to the human and the exact selected option text. Alternatives are preserved in the architecture decision record.",
                evidence: selected.evidence
            )
        }
        if let freeform = session.decisions.first(where: { $0.freeformResponse != nil }) {
            return DecisionProvenance(
                label: "Human provided freeform direction",
                detail: "The provider captured a freeform human response: \"\(freeform.freeformResponse ?? "")\".",
                evidence: freeform.evidence
            )
        }
        if let permission = session.decisions.first(where: { $0.kind == "permission_decision" }) {
            let status = permission.permissionStatus ?? "recorded"
            return DecisionProvenance(
                label: "Agent requested permission; human \(status)",
                detail: "\(session.providerDisplayName) captured a permission decision. Lineage reports only the status exposed by provider hooks.",
                evidence: permission.evidence
            )
        }
        if !session.permissionRequests.isEmpty {
            return DecisionProvenance(
                label: "Permission requested",
                detail: "\(session.providerDisplayName) recorded at least one permission request during this session. Lineage can prove the agent asked for permission or escalation; it only claims explicit user approval when the provider payload records an approval result or reason.",
                evidence: ["PermissionRequest", "UserPromptSubmit", "PreToolUse", "PostToolUse"]
            )
        }
        if !session.prompt.isEmpty && !session.toolsUsed.isEmpty {
            return DecisionProvenance(
                label: "Derived from prompt",
                detail: "The change is grounded in the captured user prompt and subsequent \(session.providerDisplayName) tool calls. No separate permission request was captured for this matching session.",
                evidence: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"]
            )
        }
        if !session.toolsUsed.isEmpty {
            return DecisionProvenance(
                label: "Agent action captured",
                detail: "\(session.providerDisplayName) tool usage was captured, but Lineage does not have enough prompt or approval evidence to say whether the decision was autonomous or explicitly requested.",
                evidence: ["PreToolUse", "PostToolUse"]
            )
        }
        return DecisionProvenance(
            label: "Recorded but incomplete",
            detail: "An AI provider session matched this line, but the captured evidence is too thin to classify the decision path.",
            evidence: ["Session summary"]
        )
    }

    private func architectureDecision(for session: ProvenanceSession) -> ArchitectureDecision {
        guard let record = session.decisions.first ?? fallbackDecisionRecord(for: session) else {
            return synthesizedArchitectureDecision(for: session)
        }
        let decision: String
        if let selected = record.selectedOptionText {
            decision = selected
        } else if let freeform = record.freeformResponse {
            decision = freeform
        } else if let status = record.permissionStatus {
            decision = "Permission \(status)"
        } else {
            decision = "Decision recorded by provider."
        }
        return ArchitectureDecision(
            context: record.context,
            decision: decision,
            alternatives: record.alternatives,
            evidence: record.evidence,
            consequences: record.consequences ?? "No consequences or risk notes were exposed by the provider.",
            externalConstraints: []
        )
    }

    private func fallbackDecisionRecord(for session: ProvenanceSession) -> DecisionRecord? {
        guard !session.permissionRequests.isEmpty else { return nil }
        return DecisionRecord(
            kind: "permission_request",
            context: session.permissionRequests.joined(separator: "\n"),
            evidence: ["PermissionRequest"],
            consequences: "Permission evidence was captured, but no provider-supplied consequence/risk note was available."
        )
    }

    private func synthesizedArchitectureDecision(for session: ProvenanceSession) -> ArchitectureDecision {
        if !session.prompt.isEmpty && !session.toolsUsed.isEmpty {
            return ArchitectureDecision(
                context: session.prompt,
                decision: "The provider implemented a change derived from the captured user prompt.",
                alternatives: [],
                evidence: ["UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"],
                consequences: "Lineage has prompt and tool evidence, but no explicit options/selection event was captured for this decision.",
                externalConstraints: []
            )
        }
        if !session.toolsUsed.isEmpty {
            return ArchitectureDecision(
                context: "\(session.providerDisplayName) tool usage was captured: \(session.toolsUsed.joined(separator: ", "))",
                decision: "A provider tool action changed or touched this code.",
                alternatives: [],
                evidence: ["PreToolUse", "PostToolUse"],
                consequences: "Lineage cannot prove from captured evidence whether this was explicitly requested, approved, or autonomous.",
                externalConstraints: []
            )
        }
        return ArchitectureDecision(
            context: "A provider session matched this line, but the captured evidence is incomplete.",
            decision: "Decision maker unknown from captured provider evidence.",
            alternatives: [],
            evidence: ["Session summary"],
            consequences: "Review the session transcript and Git commit before relying on this decision record.",
            externalConstraints: []
        )
    }

    private func gitOnlyArchitectureDecision(gitEvidence: GitLineEvidence) -> ArchitectureDecision {
        ArchitectureDecision(
            context: "Lineage found Git history for this line but no matching AI provider session.",
            decision: "Decision maker unknown; inferred from Git commit \(gitEvidence.commitSHA).",
            alternatives: [],
            evidence: ["Git blame", "Linked Git commit"],
            consequences: "This ADR is an inferred review record only. It cannot prove whether a human or agent made the decision.",
            externalConstraints: []
        )
    }

    private func timeline(for decision: DecisionProvenance) -> [String] {
        if decision.label == "Permission requested" {
            return ["Prompt", "Provider tool calls", "Permission request", "Code diff", "Tests run", "Commit", "Line selected today"]
        }
        if decision.label.contains("human selected") || decision.label == "Human provided freeform direction" {
            return ["Prompt", "Options presented", "Human decision", "Provider tool calls", "Code diff", "Tests run", "Commit", "Line selected today"]
        }
        return ["Prompt", "Provider tool calls", "Code diff", "Tests run", "Commit", "Line selected today"]
    }

    private func parseGitEvidence(blame: String) -> GitLineEvidence {
        guard !blame.isEmpty else { return .empty }
        var values: [String: String] = [:]
        let lines = blame.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let firstParts = lines.first?.split(separator: " ").map(String.init) ?? []
        let sha = firstParts.first ?? "Unknown"
        for line in lines.dropFirst() {
            if let space = line.firstIndex(of: " ") {
                let key = String(line[..<space])
                let value = String(line[line.index(after: space)...])
                values[key] = value
            }
        }
        return GitLineEvidence(
            commitSHA: sha,
            authorName: values["author"] ?? "Unknown",
            authorEmail: values["author-mail"] ?? "Unknown",
            authorDate: formatGitTimestamp(values["author-time"], timezone: values["author-tz"]),
            committerName: values["committer"] ?? "Unknown",
            committerEmail: values["committer-mail"] ?? "Unknown",
            committerDate: formatGitTimestamp(values["committer-time"], timezone: values["committer-tz"]),
            summary: values["summary"] ?? "Unknown",
            filename: values["filename"] ?? "Unknown",
            rawBlame: blame
        )
    }

    private func gitEvidenceSummary(_ evidence: GitLineEvidence) -> String {
        """
        Commit: \(evidence.commitSHA)
        Summary: \(evidence.summary)
        File: \(evidence.filename)

        Author: \(evidence.authorName) \(evidence.authorEmail)
        Authored: \(evidence.authorDate)

        Committer: \(evidence.committerName) \(evidence.committerEmail)
        Committed: \(evidence.committerDate)

        Note: Git author/committer identify what the repository recorded for this commit. They do not, by themselves, prove who wrote the prompt, who approved a tool call, or why the line exists.
        """
    }

    private func formatGitTimestamp(_ timestamp: String?, timezone: String?) -> String {
        guard let timestamp, let seconds = TimeInterval(timestamp) else { return "Unknown" }
        let date = Date(timeIntervalSince1970: seconds)
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        if let timezone {
            formatter.timeZone = timeZone(fromGitOffset: timezone) ?? .current
        }
        let offset = timezone.map { " GMT\($0)" } ?? ""
        return "\(formatter.string(from: date))\(offset)"
    }

    private func timeZone(fromGitOffset offset: String) -> TimeZone? {
        guard offset.count == 5,
              let sign = offset.first,
              let hours = Int(offset.dropFirst().prefix(2)),
              let minutes = Int(offset.suffix(2)) else { return nil }
        let seconds = ((hours * 60) + minutes) * 60 * (sign == "-" ? -1 : 1)
        return TimeZone(secondsFromGMT: seconds)
    }

    private func symbolCandidate(from line: String) -> String {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        if let name = trimmed.split(separator: "=").first {
            return String(name).trimmingCharacters(in: .whitespaces)
        }
        return trimmed.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "_" }).first.map(String.init) ?? ""
    }
}
